import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runCommand } from './run.ts';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import type { PhaseContext } from '../core/run-state/phase-context.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface PrCommandOptions {
  cwd?: string;
  configPath?: string;
  prNumber?: string;
  noPostComments?: boolean;
  noInlineComments?: boolean;
  /**
   * v6.0.9 — engine knob inputs. Same shape and precedence as scan / costs /
   * fix / plan / review / validate (CLI > env > config > built-in default off
   * in v6.0.x). The CLI dispatcher wires `cliEngine` from `--engine` /
   * `--no-engine`; `envEngine` from `process.env.CLAUDE_AUTOPILOT_ENGINE`.
   */
  cliEngine?: boolean;
  envEngine?: string;
  /**
   * Test-only seam — replaces the PR-metadata lookup (normally `gh pr view`)
   * with a static metadata struct so the engine smoke test can exercise the
   * full lifecycle without invoking `gh`. Mirrors scan / fix's
   * `__testReviewEngine` seam: production callers MUST NOT pass this.
   */
  __testPrMeta?: PrMeta;
  /**
   * Test-only seam — replaces the inner `runCommand` invocation with a stub
   * so tests can assert engine lifecycle without running the full pipeline
   * (which loads adapters, requires an LLM key, posts real PR comments,
   * etc.). The stub receives the resolved options and returns the exit
   * code it would like the verb to surface. Production callers MUST NOT
   * pass this.
   */
  __testRunCommand?: (opts: {
    cwd: string;
    configPath: string;
    base: string;
    postComments: boolean;
    inlineComments: boolean;
  }) => Promise<number>;
}

interface PrMeta {
  number: number;
  baseRefName: string;
  headRefName: string;
  title: string;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path call signature. Resolved by the outer scope (PR number
 * detection → metadata lookup → base ref fetch → post-comment knobs).
 *
 * Exported so the v6.2.1 orchestrator's phase registry can carry the typed
 * I/O shape on its `PhaseRegistration<PrInput, PrOutput>` slot.
 */
export interface PrInput {
  cwd: string;
  configPath: string;
  pr: PrMeta;
  postComments: boolean;
  inlineComments: boolean;
  runCommandImpl: (opts: {
    cwd: string;
    configPath: string;
    base: string;
    postComments: boolean;
    inlineComments: boolean;
  }) => Promise<number>;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/pr.json. The PR number is echoed so a future
 * skip-already-applied (Phase 6) can reconcile against the externalRef
 * ledger entry without re-running the review pipeline.
 *
 * Exported alongside `PrInput` for the registry's typed I/O slot.
 */
export interface PrOutput {
  prNumber: number;
  baseRefName: string;
  headRefName: string;
  postedComments: boolean;
  postedInlineComments: boolean;
  exitCode: number;
}

/** v6.2.1 — builder discriminants (parity with scan / spec / plan / implement
 *  / migrate). `pr` has multiple early-exit branches today (PR not found, gh
 *  not authenticated) — the builder surfaces them as `kind: 'early-exit'`. */
export interface BuildPrPhaseEarlyExit {
  kind: 'early-exit';
  exitCode: number;
}

export interface BuildPrPhaseResult {
  kind: 'phase';
  phase: RunPhase<PrInput, PrOutput>;
  input: PrInput;
  config: GuardrailConfig;
  renderResult: (output: PrOutput) => number;
}

function ghJson<T>(args: string[], cwd: string): T | null {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

function gitFetch(remote: string, ref: string, cwd: string): boolean {
  const r = spawnSync('git', ['fetch', remote, ref], { cwd, encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0;
}

/**
 * v6.2.1 — extract the `RunPhase<PrInput, PrOutput>` construction out of
 * `runPr(options)` so the new top-level `autopilot` orchestrator can drive
 * `runPhase` itself with a shared `phaseIdx` against the same run dir.
 * Mirrors the v6.2.0 builder pattern in scan / spec / plan / implement.
 *
 * The v6.2.1 idempotency contract for `pr` was already satisfied by the
 * v6.0.9 wrap: `executePrPhase` emits the `github-pr` externalRef BEFORE
 * `runCommand`. The contract registration in `phase-registry.ts` declares
 * `preEffectRefKinds: ['github-pr'], postEffectRefKinds: []` — the same ref
 * serves both purposes (its id is recorded pre-effect with the same value
 * `gh` reports post-create), so no post-effect ref is needed for the
 * orchestrator's resume preflight.
 */
export async function buildPrPhase(
  options: PrCommandOptions,
): Promise<BuildPrPhaseResult | BuildPrPhaseEarlyExit> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  // 5.2.2 — pr previously hard-failed when guardrail.config.yaml was missing
  // ("not found at <path>"). The first-run UX surprised users running
  // `claude-autopilot pr <n>` on a fresh repo: setup hadn't been invoked, and
  // the error didn't say to invoke it. Now matches `run`'s behavior — defer
  // config-loading to the underlying runCommand, which auto-detects stack +
  // testCommand when the file is missing.
  if (!fs.existsSync(configPath)) {
    console.log(fmt('dim', `[pr] guardrail.config.yaml not found — auto-detecting from stack signals.`));
    console.log(fmt('dim', `     Run \`claude-autopilot setup\` first to commit a config.`));
  }

  // Load config for the engine-resolution layer ONLY. The inner runCommand
  // re-loads it via its own (graceful-fallback) path, so a missing /
  // unreadable config is not fatal here either — we just default to an
  // empty config object so `runPhaseWithLifecycle` can still consult
  // `engine.enabled` (and fall through to env / CLI / built-in default).
  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    try {
      const loaded = await loadConfig(configPath);
      if (loaded) config = loaded;
    } catch {
      // Same gentle fallback as the existence check above — engine resolution
      // doesn't care about a malformed config; runCommand will surface the
      // real error with a typed message when it re-loads.
    }
  }

  // Resolve PR number — the test seam can short-circuit by providing
  // __testPrMeta directly (skipping `gh` entirely).
  let pr: PrMeta | null = options.__testPrMeta ?? null;

  if (!pr) {
    let prNumber = options.prNumber;
    if (!prNumber) {
      const detected = ghJson<{ number: number }>(['pr', 'view', '--json', 'number'], cwd);
      if (!detected) {
        console.error(fmt('red', '[pr] No PR number given and no open PR found for current branch.'));
        console.error(fmt('dim', '  Usage: guardrail pr <number>'));
        return { kind: 'early-exit', exitCode: 1 };
      }
      prNumber = String(detected.number);
    }

    // Look up PR metadata
    const meta = ghJson<PrMeta>(['pr', 'view', prNumber, '--json', 'number,baseRefName,headRefName,title'], cwd);
    if (!meta) {
      console.error(fmt('red', `[pr] Could not fetch PR #${prNumber} — is gh authenticated?`));
      return { kind: 'early-exit', exitCode: 1 };
    }
    pr = meta;
  }

  console.log(`\n${fmt('bold', `[pr]`)} #${pr.number} ${fmt('dim', pr.title)}`);
  console.log(fmt('dim', `  base: ${pr.baseRefName}  head: ${pr.headRefName}`));

  // Fetch base ref so diff works locally. Skipped under the test seam —
  // tests don't need a real git remote.
  if (!options.__testPrMeta) {
    const fetched = gitFetch('origin', pr.baseRefName, cwd);
    if (!fetched) {
      console.log(fmt('yellow', `  [pr] Warning: could not fetch origin/${pr.baseRefName} — diff may be stale`));
    }
  }

  // INTENTIONAL DECLARATION (verified against the existing impl, v6.0.9):
  //
  // The v6 spec table (docs/specs/v6-run-state-engine.md) lists `pr` with
  // `idempotent: no, hasSideEffects: yes, externalRefs: github-pr`. The
  // wrap below MATCHES the spec — `pr` is genuinely side-effecting:
  //
  //   1. Inside `runCommand` (src/cli/run.ts), when `postComments` is true,
  //      `postPrComment(...)` is called which either creates a brand-new
  //      issue comment via `gh pr comment` OR PATCHes an existing one
  //      identified by the `<!-- guardrail-review -->` marker. Re-runs are
  //      effectively idempotent on the comment body (marker-based dedup),
  //      but the underlying gh API call is still mutating.
  //   2. When `inlineComments` is true, `postReviewComments(...)` is called
  //      which (a) DISMISSES any prior autopilot review (PUT
  //      reviews/<id>/dismissals) and (b) POSTS a new review with inline
  //      comments. A re-run produces a DIFFERENT review ID each time —
  //      not byte-identical, definitively not safe to replay without
  //      gating. Per the spec, this is the textbook hasSideEffects: true
  //      case.
  //
  // ExternalRef plumbing: the phase records a `github-pr` externalRef with
  // the PR number as soon as it has resolved metadata (via
  // `ctx.emitExternalRef`). This is recorded BEFORE `runCommand` runs so a
  // crash mid-pipeline still leaves a breadcrumb pointing at the PR. A
  // future v6.0.x extension may add `github-comment` externalRefs after
  // `postPrComment` returns the comment URL — that requires plumbing the
  // post-comment URL out of `runCommand` (currently it's only logged), so
  // it's deferred to a follow-up PR. For v6.0.9 the `github-pr` ref is
  // sufficient: a Phase 6 readback can `gh pr view <id>` to confirm the PR
  // is still open before deciding whether a replay is safe.
  //
  // Why `noPostComments` / `noInlineComments` don't change the declaration:
  // `idempotent` and `hasSideEffects` describe the verb's behavior shape,
  // not the runtime decision a particular flag combination produces. Even
  // if both flags are passed, the verb's contract is "side-effecting by
  // default"; the engine's gating layer doesn't try to introspect runtime
  // flag combinations. (If users want a read-only PR review with no
  // platform mutation, the right verb today is `claude-autopilot run`
  // without `--post-comments` / `--inline-comments`.)
  const phase: RunPhase<PrInput, PrOutput> = {
    name: 'pr',
    // Per the spec table — re-running can produce different externalRefs
    // (a new review ID on each `postReviewComments` call). Engine gates
    // replays accordingly: a prior phase.success requires either
    // `--force-replay` or a successful provider readback before retrying.
    idempotent: false,
    // Posts to GitHub via `gh` CLI inside runCommand. See the long
    // declaration note above for the per-call breakdown.
    hasSideEffects: true,
    run: async (input, ctx) => executePrPhase(input, ctx),
  };

  const prInput: PrInput = {
    cwd,
    configPath,
    pr,
    postComments: !options.noPostComments,
    inlineComments: !options.noInlineComments,
    runCommandImpl: options.__testRunCommand ?? (opts => runCommand(opts)),
  };

  return {
    kind: 'phase',
    phase,
    input: prInput,
    config,
    renderResult: (output: PrOutput) => output.exitCode,
  };
}

export async function runPr(options: PrCommandOptions = {}): Promise<number> {
  const built = await buildPrPhase(options);
  if (built.kind === 'early-exit') return built.exitCode;

  const { phase, input: prInput, config, renderResult } = built;

  // v6.0.9 — lifecycle wiring lives in `runPhaseWithLifecycle`. The helper
  // owns the engine-on/engine-off branch and the failure banner; the caller
  // just supplies the phase, the input, and the engine-off escape hatch.
  let output: PrOutput;
  try {
    const result = await runPhaseWithLifecycle<PrInput, PrOutput>({
      cwd: prInput.cwd,
      phase,
      input: prInput,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      // Engine-off escape hatch — runs the same phase body without the
      // lifecycle wrapper. No PhaseContext available off-engine, so the
      // emitExternalRef call is a no-op (ctx is null) — same precedent as
      // every other wrapped verb's engine-off path.
      runEngineOff: () => executePrPhase(prInput, null),
    });
    output = result.output;
  } catch {
    // Helper already printed the failure banner + emitted run.complete
    // failed + refreshed state.json + released the lock.
    return 1;
  }

  return renderResult(output);
}

// ---------------------------------------------------------------------------
// Phase body — record the PR externalRef, then delegate to runCommand. The
// phase body itself is small; the heavy lifting (review pipeline, comment
// posting) is owned by runCommand. INTENTIONAL DEVIATION from the
// "pure phase body" recipe default: runCommand emits its own console output
// (phase summaries, finding tables, comment-posting status). Same precedent
// as scan keeping its LLM call inside the phase body — runCommand is the
// existing engine of pr's value, not something to extract.
// ---------------------------------------------------------------------------

async function executePrPhase(
  input: PrInput,
  ctx: PhaseContext | null,
): Promise<PrOutput> {
  const { cwd, configPath, pr, postComments, inlineComments, runCommandImpl } = input;

  // Record the github-pr externalRef BEFORE the runCommand invocation so a
  // crash mid-pipeline still leaves a breadcrumb pointing at the PR. The
  // engine path's Phase 6 resume logic can then `gh pr view <id>` to
  // confirm the PR is still open before deciding whether a replay is safe.
  if (ctx) {
    ctx.emitExternalRef({
      kind: 'github-pr',
      id: String(pr.number),
      provider: 'github',
    });
  }

  const exitCode = await runCommandImpl({
    cwd,
    configPath,
    base: `origin/${pr.baseRefName}`,
    postComments,
    inlineComments,
  });

  return {
    prNumber: pr.number,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    postedComments: postComments,
    postedInlineComments: inlineComments,
    exitCode,
  };
}
