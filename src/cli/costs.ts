import * as path from 'node:path';
import * as fs from 'node:fs';
import { readCostLog } from '../core/persist/cost-log.ts';
import type { CostLogEntry } from '../core/persist/cost-log.ts';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { resolveEngineEnabled, type ResolveEngineResult } from '../core/run-state/resolve-engine.ts';
import { createRun } from '../core/run-state/runs.ts';
import { runPhase, type RunPhase } from '../core/run-state/phase-runner.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return iso; }
}

function fmtUSD(n: number): string {
  return n === 0 ? fmt('dim', '$0.0000') : `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface CostsCommandOptions {
  cwd?: string;
  configPath?: string;
  /**
   * v6.0.2 — engine knob inputs. Same shape and precedence as scan
   * (CLI > env > config > built-in default off in v6.0.x). The CLI dispatcher
   * wires `cliEngine` from `--engine` / `--no-engine`; `envEngine` from
   * `process.env.CLAUDE_AUTOPILOT_ENGINE`. An absent CLI flag + absent env
   * value falls through to the loaded config and then to the built-in
   * default.
   */
  cliEngine?: boolean;
  envEngine?: string;
}

/**
 * Phase input — minimal, since costs is purely a read-only summary of the
 * project's cost-ledger file. Captured as a struct so the engine path's
 * phase body matches the engine-off path call signature.
 */
interface CostsInput {
  cwd: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/costs.json. A future skip-already-applied (Phase 6)
 * could restore this without re-reading the file. Mirrors the shape rendered
 * by `renderCostsOutput` so the engine path and the legacy path share the
 * exact same data flow.
 */
interface CostsOutput {
  /** Number of entries in the cost log. */
  entryCount: number;
  /** All-time totals across the full log. */
  totals: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  };
  /** 7-day rolling window. */
  recent: {
    runs: number;
    costUSD: number;
  };
  /** Last 10 runs (newest first), rendered into the table. */
  last10: CostLogEntry[];
}

export async function runCosts(cwdOrOptions: string | CostsCommandOptions = {}): Promise<number> {
  // Back-compat — early callers (tests, MCP) pass a bare `cwd: string`. The
  // tests/costs.test.ts harness drives this shape directly. Promote both
  // forms into a single options struct so the rest of the function can treat
  // it uniformly.
  const options: CostsCommandOptions = typeof cwdOrOptions === 'string'
    ? { cwd: cwdOrOptions }
    : cwdOrOptions;
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // v6.0.2 — engine resolution. CLI > env > config > default. The CLI
  // dispatcher passes cliEngine + envEngine; the config layer comes from the
  // YAML we just loaded. Resolved BEFORE the legacy "no log file" early-return
  // so engine-on still creates a run dir + emits lifecycle events even when
  // the log is empty (matches scan's behavior of always producing a run dir
  // when --engine is requested).
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean' ? { configEnabled: config.engine.enabled } : {}),
  });

  const costsInput: CostsInput = { cwd };

  // The wrapped phase body — pure read of the cost ledger + summary build.
  // Extracted into a RunPhase so the engine-on path and the engine-off path
  // share the exact same logic. Engine-off callers invoke this directly via
  // `executeCostsPhase()`; engine-on callers route through `runPhase()`.
  const phase: RunPhase<CostsInput, CostsOutput> = {
    name: 'costs',
    // Cost summary is a pure read of `.guardrail-cache/costs.jsonl` — re-running
    // produces identical output for identical ledger contents. Always safe to
    // retry.
    idempotent: true,
    // No provider calls, no git push, no PR comment, no file writes (the
    // ledger is read-only on this path; the writer is `appendCostLog` called
    // by other verbs). Replays are safe.
    hasSideEffects: false,
    run: async input => executeCostsPhase(input),
  };

  let output: CostsOutput;
  if (engineResolved.enabled) {
    // v6.0.2 — wire costs through the Run State Engine. Same shape as scan:
    // createRun → runPhase → run.complete + state.json refresh + best-effort
    // lock release in finally.
    const created = await createRun({
      cwd,
      phases: ['costs'],
      config: {
        engine: { enabled: true, source: engineResolved.source },
        ...(engineResolved.invalidEnvValue !== undefined
          ? { invalidEnvValue: engineResolved.invalidEnvValue }
          : {}),
      },
    });
    if (engineResolved.invalidEnvValue !== undefined) {
      // Surface the invalid env value as a typed warning so observers
      // (`runs show <id> --events`) can attribute the fallthrough.
      appendEvent(
        created.runDir,
        {
          event: 'run.warning',
          message: `invalid CLAUDE_AUTOPILOT_ENGINE=${JSON.stringify(engineResolved.invalidEnvValue)} ignored`,
          details: { resolution: engineResolved },
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
    }
    const runStartedAt = Date.now();
    try {
      output = await runPhase<CostsInput, CostsOutput>(phase, costsInput, {
        runDir: created.runDir,
        runId: created.runId,
        writerId: created.lock.writerId,
        phaseIdx: 0,
      });
      appendEvent(
        created.runDir,
        {
          event: 'run.complete',
          status: 'success',
          totalCostUSD: 0,
          durationMs: Date.now() - runStartedAt,
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
      writeStateSnapshot(created.runDir, replayState(created.runDir));
    } catch (err) {
      appendEvent(
        created.runDir,
        {
          event: 'run.complete',
          status: 'failed',
          totalCostUSD: 0,
          durationMs: Date.now() - runStartedAt,
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
      writeStateSnapshot(created.runDir, replayState(created.runDir));
      console.error(fmt('red', `[costs] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    // Engine off — legacy stateless path. Behavior is byte-for-byte identical
    // to v6.0.1 so existing CI / scripts are unaffected.
    output = await executeCostsPhase(costsInput);
  }

  return renderCostsOutput(output, costsInput);
}

// ---------------------------------------------------------------------------
// Phase body — read the cost ledger and assemble the summary. Pure: no
// console output, no exit codes. Returns a JSON-serializable CostsOutput so
// the engine can persist it as `result` on the phase snapshot.
// ---------------------------------------------------------------------------

async function executeCostsPhase(input: CostsInput): Promise<CostsOutput> {
  const log = readCostLog(input.cwd);

  // 7-day window
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = log.filter(e => new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const last10 = log.slice(-10).reverse();

  const totalCost = log.reduce((s, e) => s + e.costUSD, 0);
  const totalInput = log.reduce((s, e) => s + e.inputTokens, 0);
  const totalOutput = log.reduce((s, e) => s + e.outputTokens, 0);
  const recentCost = recent.reduce((s, e) => s + e.costUSD, 0);

  return {
    entryCount: log.length,
    totals: {
      runs: log.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      costUSD: totalCost,
    },
    recent: {
      runs: recent.length,
      costUSD: recentCost,
    },
    last10,
  };
}

// ---------------------------------------------------------------------------
// Render — translate CostsOutput back to the legacy stdout summary + exit
// code. Lives outside the wrapped phase because it's pure presentation;
// doing the rendering inside the phase would couple the engine path's
// idempotency to console output.
// ---------------------------------------------------------------------------

function renderCostsOutput(output: CostsOutput, input: CostsInput): number {
  const { cwd } = input;
  const { entryCount, totals, recent, last10 } = output;

  if (entryCount === 0) {
    console.log(fmt('yellow', `[costs] No run history found in ${cwd} — run \`guardrail run\` first.`));
    console.log(fmt('dim', `        (Costs are scoped per-project. \`cd\` to the project before checking.)`));
    return 0;
  }

  console.log(`\n${fmt('bold', '[costs]')} ${fmt('dim', cwd)}\n`);

  // Summary row
  console.log(fmt('bold', 'Summary'));
  console.log(`  All-time runs:   ${totals.runs}`);
  console.log(`  All-time cost:   ${fmtUSD(totals.costUSD)}  (${fmtTokens(totals.inputTokens)} in / ${fmtTokens(totals.outputTokens)} out)`);
  console.log(`  Last 7 days:     ${fmtUSD(recent.costUSD)}  (${recent.runs} run${recent.runs !== 1 ? 's' : ''})`);
  console.log(fmt('dim', `  (per-project — scoped to ${cwd}/.guardrail-cache/costs.jsonl)`));
  console.log('');

  // Last 10 runs table
  console.log(fmt('bold', `Recent runs (last ${last10.length})`));
  const COL = { date: 22, files: 7, input: 8, output: 8, cost: 10, dur: 8 };
  const header = [
    'Date'.padEnd(COL.date),
    'Files'.padStart(COL.files),
    'In tok'.padStart(COL.input),
    'Out tok'.padStart(COL.output),
    'Cost'.padStart(COL.cost),
    'Time'.padStart(COL.dur),
  ].join('  ');
  console.log(fmt('dim', '  ' + header));
  console.log(fmt('dim', '  ' + '─'.repeat(header.length)));

  for (const e of last10) {
    const row = [
      formatDate(e.timestamp).padEnd(COL.date),
      String(e.files).padStart(COL.files),
      fmtTokens(e.inputTokens).padStart(COL.input),
      fmtTokens(e.outputTokens).padStart(COL.output),
      fmtUSD(e.costUSD).padStart(COL.cost + 9), // +9 for ANSI codes in dim
      `${e.durationMs}ms`.padStart(COL.dur),
    ].join('  ');
    console.log('  ' + row);
  }

  console.log('');
  return 0;
}
