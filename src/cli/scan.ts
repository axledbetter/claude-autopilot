import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import { runReviewPhase } from '../core/pipeline/review-phase.ts';
import { detectStack } from '../core/detect/stack.ts';
import { loadIgnoreRules, parseConfigIgnore, applyIgnoreRules } from '../core/ignore/index.ts';
import { saveCachedFindings } from '../core/persist/findings-cache.ts';
import { appendCostLog } from '../core/persist/cost-log.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { detectLLMKey, LLM_KEY_HINTS } from '../core/detect/llm-key.ts';
import { resolveEngineEnabled, type ResolveEngineResult } from '../core/run-state/resolve-engine.ts';
import { createRun } from '../core/run-state/runs.ts';
import { runPhase, type RunPhase } from '../core/run-state/phase-runner.ts';
import { appendEvent, replayState } from '../core/run-state/events.ts';
import { writeStateSnapshot } from '../core/run-state/state.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.guardrail-cache', '.autopilot', '__pycache__', '.venv', 'vendor',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.cs', '.php',
  '.sql', '.sh', '.bash', '.yaml', '.yml', '.json', '.toml',
]);

function collectFiles(target: string, cwd: string): string[] {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  if (!fs.existsSync(abs)) return [];

  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];

  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }
  walk(abs);
  return results;
}

function collectAllFiles(cwd: string): string[] {
  return collectFiles(cwd, cwd);
}

export interface ScanCommandOptions {
  cwd?: string;
  configPath?: string;
  targets?: string[];   // explicit paths/dirs to scan
  all?: boolean;        // scan entire codebase
  ask?: string;         // targeted question to inject into review prompt
  focus?: 'security' | 'logic' | 'performance' | 'brand' | 'all';
  dryRun?: boolean;
  /**
   * v6.0.1 — engine knob inputs. The CLI dispatcher gathers these and the
   * resolver picks a winner against (cli > env > config > built-in default).
   * Both fields are optional; an absent CLI flag + absent env value falls
   * through to the loaded config and then to the built-in default (off in v6.0).
   */
  cliEngine?: boolean;
  envEngine?: string;
  /**
   * Test-only seam — injects a pre-built ReviewEngine so tests can exercise
   * the engine-wrap path without hitting `loadAdapter()` (and therefore
   * without needing an LLM API key in the environment). Production callers
   * MUST NOT pass this; the CLI dispatcher does not expose a flag that sets
   * it. Underscore-prefixed to make the test-seam intent obvious in code
   * search.
   */
  __testReviewEngine?: ReviewEngine;
}

/**
 * Input handed to the wrapped `RunPhase<ScanInput, ScanOutput>` body. Captures
 * everything the phase needs that's already been resolved by the outer scope
 * (file list, engine, focus hint, etc.) so the phase body itself is a thin
 * await on `runReviewPhase` + finding post-processing.
 */
interface ScanInput {
  files: string[];
  relFiles: string[];
  cwd: string;
  config: GuardrailConfig;
  engine: ReviewEngine;
  focusHint: string;
  ask?: string;
  focusLabel: string | null;
  all: boolean;
}

/** What the wrapped phase returns. The outer scope translates this back to
 *  the legacy stdout banner + exit code path. Keeping the shape JSON-
 *  serializable means runPhase persists it into phases/<name>.json so a
 *  future skip-already-applied can restore it without re-running the LLM. */
interface ScanOutput {
  /** Total files actually sent to the review engine. */
  fileCount: number;
  /** Findings after ignore-rule filtering. Tagged with severity so a JSON
   *  consumer can reason about pass/fail without re-reading the cache. */
  findings: Array<{
    severity: 'critical' | 'warning' | 'note';
    message: string;
    file?: string;
    line?: number;
    suggestion?: string;
  }>;
  costUSD?: number;
  durationMs: number;
  /** Pass-through of the LLM's raw text outputs when --ask returned prose
   *  rather than structured findings — replicates the legacy "Answer:" path. */
  rawOutputs?: string[];
}

export async function runScan(options: ScanCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // v6.0.1 — engine resolution. CLI > env > config > default (default v6.0:
  // off). The CLI dispatcher passes cliEngine + envEngine through; the
  // config layer comes from the YAML we just loaded. We resolve here, BEFORE
  // collecting files / deciding whether to dry-run, so the resolution is
  // always deterministic from the same inputs.
  const engineResolved: ResolveEngineResult = resolveEngineEnabled({
    ...(options.cliEngine !== undefined ? { cliEngine: options.cliEngine } : {}),
    ...(options.envEngine !== undefined ? { envValue: options.envEngine } : {}),
    ...(typeof config.engine?.enabled === 'boolean' ? { configEnabled: config.engine.enabled } : {}),
  });

  // Collect files
  let files: string[];
  if (options.all) {
    files = collectAllFiles(cwd);
  } else if (options.targets && options.targets.length > 0) {
    files = options.targets.flatMap(t => collectFiles(t, cwd));
  } else {
    console.error(fmt('red', '[scan] Specify a path, --all, or use `guardrail run` for git-changed files'));
    console.error(fmt('dim', '  Examples:'));
    console.error(fmt('dim', '    guardrail scan src/auth/'));
    console.error(fmt('dim', '    guardrail scan --all'));
    console.error(fmt('dim', '    guardrail scan --ask "is there SQL injection?" src/db/'));
    return 1;
  }

  // Deduplicate
  files = [...new Set(files)];

  if (files.length === 0) {
    console.log(fmt('yellow', '[scan] No code files found at the specified path(s)'));
    return 0;
  }

  if (options.dryRun) {
    console.log(fmt('bold', `[scan] Would scan ${files.length} file(s):`));
    for (const f of files) console.log(fmt('dim', `  ${path.relative(cwd, f)}`));
    return 0;
  }

  // Auto-detect stack if not in config
  if (!config.stack) {
    config = { ...config, stack: detectStack(cwd) ?? undefined };
  }

  // Build review engine
  let engine: ReviewEngine;
  if (options.__testReviewEngine) {
    // Test-only fast path — skip the LLM key check and the adapter loader.
    engine = options.__testReviewEngine;
  } else {
    if (!detectLLMKey().hasKey) {
      console.error(fmt('red', '[scan] No LLM API key — set one of:'));
      for (const { name, url, note } of LLM_KEY_HINTS) {
        const suffix = note ? `  (${note})` : '';
        console.error(fmt('dim', `         ${name.padEnd(18)} ${url}${suffix}`));
      }
      return 1;
    }
    const engineRef = typeof config.reviewEngine === 'string' ? config.reviewEngine
      : (config.reviewEngine?.adapter ?? 'auto');
    try {
      engine = await loadAdapter<ReviewEngine>({
        point: 'review-engine',
        ref: engineRef,
        options: typeof config.reviewEngine === 'object' ? config.reviewEngine.options as Record<string, unknown> : undefined,
      });
    } catch (err) {
      console.error(fmt('red', `[scan] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
  }

  const focusLabel = options.focus && options.focus !== 'all' ? options.focus : null;
  const relFiles = files.map(f => path.relative(cwd, f));

  console.log('');
  const scopeDesc = options.all ? 'entire codebase' : relFiles.slice(0, 3).join(', ') + (relFiles.length > 3 ? ` +${relFiles.length - 3} more` : '');
  console.log(fmt('bold', `[scan]`) + fmt('dim', ` ${files.length} file(s) — ${scopeDesc}`));
  if (options.ask) console.log(fmt('dim', `  question: ${options.ask}`));
  if (focusLabel) console.log(fmt('dim', `  focus: ${focusLabel}`));
  if (engineResolved.enabled) {
    console.log(fmt('dim', `  engine: on (${engineResolved.source})`));
  }
  console.log('');

  // Build a focused git summary / prompt context
  const focusHint = buildFocusHint(options.ask, focusLabel);

  const scanInput: ScanInput = {
    files,
    relFiles,
    cwd,
    config,
    engine,
    focusHint,
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
    focusLabel,
    all: options.all === true,
  };

  // The wrapped phase body — pure call-the-LLM-and-process-findings work.
  // Extracted into a RunPhase so the engine path and the legacy path share
  // the exact same logic. Engine-off callers invoke this directly via
  // `executeScanPhase()`; engine-on callers route through `runPhase()`.
  const phase: RunPhase<ScanInput, ScanOutput> = {
    name: 'scan',
    // scan re-issues identical LLM queries against the same code — re-running
    // is safe and cheap-ish to retry.
    idempotent: true,
    // No git push, no PR comment, no provider-side mutation. The cost-log
    // append + findings-cache write are local file IO that's already
    // overwrite-style; replays are safe.
    hasSideEffects: false,
    run: executeScanPhase,
  };

  let output: ScanOutput;
  if (engineResolved.enabled) {
    // v6.0.1 — wire scan through the Run State Engine. Creates a run dir at
    // .guardrail-cache/runs/<ulid>/ with state.json + events.ndjson, runs the
    // phase via runPhase (which emits phase.start / phase.success / phase.cost),
    // and emits run.complete on the way out.
    const created = await createRun({
      cwd,
      phases: ['scan'],
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
      output = await runPhase<ScanInput, ScanOutput>(phase, scanInput, {
        runDir: created.runDir,
        runId: created.runId,
        writerId: created.lock.writerId,
        phaseIdx: 0,
      });
      // Final lifecycle event — run.complete. The runner doesn't emit this
      // on its own; it's the caller's responsibility (multi-phase pipelines
      // emit it after the LAST phase, single-phase wrappers like this emit
      // after the only phase).
      const totalCostUSD = output.costUSD ?? 0;
      appendEvent(
        created.runDir,
        {
          event: 'run.complete',
          status: 'success',
          totalCostUSD,
          durationMs: Date.now() - runStartedAt,
        },
        { writerId: created.lock.writerId, runId: created.runId },
      );
      // Refresh state.json from the replayed events. The events.ndjson is
      // the source of truth; state.json is a derived snapshot that we MUST
      // rewrite after run.complete so `runs show` / `runs list` reflect the
      // terminal status without needing to replay on every read. (The runs
      // CLI doctor verb does the same rewrite when it detects drift.)
      writeStateSnapshot(created.runDir, replayState(created.runDir));
    } catch (err) {
      // Engine-on: write run.complete with failed status, then surface the
      // error to the legacy text-mode handler which prints + exits 1.
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
      console.error(fmt('red', `[scan] engine: phase failed — ${err instanceof Error ? err.message : String(err)}`));
      console.error(fmt('dim', `  inspect: claude-autopilot runs show ${created.runId} --events`));
      await created.lock.release();
      return 1;
    } finally {
      // Best-effort lock release — the wrapper sometimes runs to completion
      // before the catch block runs, in which case the catch's release is
      // skipped. Doing it here in finally is safe (release is idempotent).
      await created.lock.release().catch(() => { /* ignore */ });
    }
  } else {
    // Engine off — legacy stateless path. Behavior is byte-for-byte identical
    // to v6.0 so existing CI / scripts are unaffected.
    output = await executeScanPhase(scanInput);
  }

  return renderScanOutput(output, scanInput);
}

// ---------------------------------------------------------------------------
// Phase body — the LLM call + finding processing + cost-log append + findings
// cache write. Extracted from runScan so the engine-on path can wrap it via
// `runPhase` and the engine-off path can call it directly. Returns a
// JSON-serializable ScanOutput so the engine can persist it as `result` on
// the phase snapshot.
// ---------------------------------------------------------------------------

async function executeScanPhase(input: ScanInput): Promise<ScanOutput> {
  const { files, relFiles, cwd, config, engine, focusHint, ask } = input;

  const result = await runReviewPhase({
    touchedFiles: relFiles,
    engine,
    config,
    cwd,
    gitSummary: focusHint,
  });

  // Single-file scan: every finding is about that file (or its imports).
  // The LLM sometimes emits prose tokens like "n.r" or "fn.c" that the parser
  // greedily matches as a file ref, producing junk paths that break `fix`.
  // For single-file scan we KNOW the file — overwrite unconditionally rather
  // than only filling `<unspecified>`. The 5.0.6 fallback was conditional on
  // `<unspecified>` and missed the prose-noise case, leaving findings with
  // bogus `n.r` paths that broke `fix --severity all` ("no fixable findings").
  if (relFiles.length === 1) {
    const onlyFile = relFiles[0]!;
    for (const f of result.findings) {
      f.file = onlyFile;
    }
  }

  // Apply ignore rules
  const ignoreRules = [...loadIgnoreRules(cwd), ...parseConfigIgnore(config.ignore)];
  const findings = applyIgnoreRules(result.findings, ignoreRules);

  // Persist findings so `guardrail fix` can read them
  saveCachedFindings(cwd, findings);

  // Persist run to cost log so `claude-autopilot costs` reflects scans, not
  // just full pipeline runs. Previously scan never wrote to the log, so the
  // costs report stayed frozen at whatever the last `run` invocation produced.
  appendCostLog(cwd, {
    timestamp: new Date().toISOString(),
    files: files.length,
    inputTokens: result.usage?.input ?? 0,
    outputTokens: result.usage?.output ?? 0,
    costUSD: result.costUSD ?? 0,
    durationMs: result.durationMs,
  });

  return {
    fileCount: files.length,
    findings: findings.map(f => ({
      severity: f.severity as 'critical' | 'warning' | 'note',
      message: f.message,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    })),
    ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
    durationMs: result.durationMs,
    ...(result.rawOutputs !== undefined ? { rawOutputs: result.rawOutputs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Render — translate ScanOutput back to the legacy stdout banner + exit code.
// Lives outside the wrapped phase because it's pure presentation; doing the
// rendering inside the phase would couple the engine path's idempotency to
// console output, which we don't want.
// ---------------------------------------------------------------------------

function renderScanOutput(output: ScanOutput, input: ScanInput): number {
  const { findings, costUSD, durationMs, rawOutputs } = output;
  const { ask } = input;

  // Print results
  if (findings.length === 0 && ask && rawOutputs && rawOutputs.length > 0) {
    // --ask returned prose rather than structured findings — surface raw response
    console.log(fmt('cyan', `Answer:`));
    for (const raw of rawOutputs) {
      // Strip markdown fences and the ## Findings / ## Review Summary headers if present
      const cleaned = raw.replace(/^##\s+Review Summary\s*\n/gm, '').replace(/^##\s+Findings\s*\n/gm, '').trim();
      console.log(cleaned);
    }
    console.log('');
  } else if (findings.length === 0) {
    console.log(fmt('green', '✓ No findings'));
  } else {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const notes    = findings.filter(f => f.severity === 'note');

    if (critical.length > 0) {
      console.log(fmt('red', `🚨 ${critical.length} critical`));
      for (const f of critical) {
        const loc = f.file && f.file !== '<unspecified>' ? fmt('dim', `${f.file}${f.line ? `:${f.line}` : ''}`) + ' ' : '';
        console.log(`  ${loc}${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `    → ${f.suggestion}`));
      }
      console.log('');
    }
    if (warnings.length > 0) {
      console.log(fmt('yellow', `⚠  ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`));
      for (const f of warnings) {
        const loc = f.file && f.file !== '<unspecified>' ? fmt('dim', `${f.file}${f.line ? `:${f.line}` : ''}`) + ' ' : '';
        console.log(`  ${loc}${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `    → ${f.suggestion}`));
      }
      console.log('');
    }
    if (notes.length > 0) {
      console.log(fmt('dim', `ℹ  ${notes.length} note${notes.length !== 1 ? 's' : ''}`));
      for (const f of notes) {
        const loc = f.file && f.file !== '<unspecified>' ? `${f.file}${f.line ? `:${f.line}` : ''} ` : '';
        console.log(fmt('dim', `  ${loc}${f.message}`));
      }
      console.log('');
    }
  }

  if (costUSD !== undefined) {
    console.log(fmt('dim', `  $${costUSD.toFixed(4)} · ${durationMs}ms`));
  }

  const fixable = findings.filter(f => f.severity === 'critical' || f.severity === 'warning');
  if (fixable.length > 0) {
    console.log(fmt('dim', `  → run \`guardrail fix\` to auto-fix ${fixable.length} finding${fixable.length !== 1 ? 's' : ''}`));
  }

  return findings.some(f => f.severity === 'critical') ? 1 : 0;
}

function buildFocusHint(ask: string | undefined, focus: string | null): string {
  const parts: string[] = [];
  if (ask) {
    parts.push(
      `TARGETED QUESTION (required): The reviewer specifically wants to know: "${ask}". ` +
      `You MUST answer this question using the structured findings format. ` +
      `Even if no issues are found, output at least one ### [NOTE] finding that directly answers the question.`,
    );
  }
  if (focus === 'security') parts.push('Focus: security vulnerabilities, auth issues, injection risks, data exposure');
  if (focus === 'logic') parts.push('Focus: logic bugs, incorrect behavior, edge cases, null handling, async errors');
  if (focus === 'performance') parts.push('Focus: performance issues, N+1 queries, blocking I/O, memory leaks');
  return parts.join(' | ');
}
