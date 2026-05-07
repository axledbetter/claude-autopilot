// src/cli/migrate.ts
//
// v6.0.8 — engine-wrap shell for the `migrate` pipeline phase. Runs the
// stack-aware migrate dispatcher (`src/core/migrate/dispatcher.ts`) inside
// a `RunPhase<MigrateInput, MigrateOutput>` so v6 pipeline runs check-
// point a `migrate` phase entry alongside `plan`, `review`, and
// `validate`.
//
// migrate is the FIRST side-effecting phase to land under
// `runPhaseWithLifecycle` (followed by `implement` and `pr` in v6.0.7 +
// v6.0.9 — see the rebase contract in PR #102 / #103). The wrap declares:
//
//   idempotent:     false   (per spec table at docs/specs/v6-run-state-engine.md)
//   hasSideEffects: true    (applies migrations against a database)
//   externalRefs:   migration-version (one per applied migration / per env)
//
// Why `idempotent: false` even though the underlying skill is ledger-
// guarded:
//   The Delegance migrate skill (and all conforming `migrate@1` skills)
//   tracks applied migrations in a ledger table — re-running the verb
//   against a database that already has a given migration applied is a
//   no-op (the dispatcher returns `status: 'skipped'`, `reasonCode:
//   migration-disabled` or skill-specific equivalent). So at the
//   *outcome* layer, replay is safe.
//
//   At the *engine semantics* layer, however, `idempotent: true` means
//   "re-running the phase against the same input produces equivalent
//   output." A dispatch invocation that previously applied N migrations
//   on attempt 1 and applies 0 on attempt 2 (everything already in the
//   ledger) DOES produce different output (different `appliedMigrations`
//   list, different `status`). The spec table's `idempotent: false` is
//   the right declaration.
//
//   The practical consequence: when a prior `phase.success` exists for
//   `migrate` and the engine is asked to retry, it consults the
//   persisted `externalRefs` (`migration-version` entries) to decide
//   whether to skip-already-applied or retry. Phase 6 will wire the
//   read-back to live `migration_state` queries; until then, retries on
//   side-effecting phases require `--force-replay`. Documented in
//   docs/v6/migration-guide.md "Idempotency + replay rules".
//
// Why `hasSideEffects: true`:
//   Migrations mutate database schema / seed data. The dispatcher writes
//   audit log entries, schema cache refreshes, types regeneration. The
//   engine's "no replay without read-back" gate is exactly what we want.
//
// `migration-version` externalRefs:
//   For every migration name in `result.appliedMigrations`, we emit a
//   `phase.externalRef` event with `kind: 'migration-version'` and `id`
//   shaped as `<env>:<migration_name>`. The `<env>:` prefix scopes the
//   ref by target environment (dev / qa / prod) so multi-env pipelines
//   can read back per-env state. Phase 6's read-back rule will compare
//   the persisted set to the live ledger to decide skip-already-applied
//   vs retry vs needs-human.
//
// Engine-off path (default through v6.0.x): byte-for-byte identical to
// the pre-v6.0.8 inline dispatch case in `src/cli/index.ts`. The
// `runEngineOff` callback supplied to `runPhaseWithLifecycle` invokes
// the same dispatch + render shape that the legacy code path used. CI /
// scripts that don't pass `--engine` are unaffected.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { type RunPhase } from '../core/run-state/phase-runner.ts';
import { runPhaseWithLifecycle } from '../core/run-state/run-phase-with-lifecycle.ts';
import { dispatch as runMigrateDispatch } from '../core/migrate/dispatcher.ts';
import type { ResultArtifact } from '../core/migrate/types.ts';
import { findPackageRoot } from './_pkg-root.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface MigrateCommandOptions {
  cwd?: string;
  configPath?: string;
  /** Target environment from `.autopilot/stack.md`. Defaults to `dev`. */
  env?: string;
  /** When true, the dispatcher passes `dryRun: true` through the envelope so
   *  the skill executes a no-side-effect plan rather than applying. */
  dryRun?: boolean;
  /** `--yes` — required to apply prod migrations in CI per policy. */
  yesFlag?: boolean;
  /** `--non-interactive` / `--json` / not-a-TTY equivalent. */
  nonInteractive?: boolean;
  /**
   * v6.0.8 — engine knob inputs. Same precedence as scan / costs / fix /
   * plan / review / validate (CLI > env > config > built-in default off).
   */
  cliEngine?: boolean;
  envEngine?: string;
  /**
   * Test-only seam — replaces the real dispatcher with a fake so smoke
   * tests can exercise the engine-wrap path without spawning a child
   * process or hitting a real database. Production callers MUST NOT
   * pass this; the CLI dispatcher in `src/cli/index.ts` does not expose
   * a flag that sets it. Underscore-prefixed for grep-ability.
   */
  __testDispatch?: (input: MigrateInput) => Promise<ResultArtifact>;
}

/**
 * Phase input — captured as a struct so the engine path's phase body matches
 * the engine-off path's call signature.
 */
interface MigrateInput {
  cwd: string;
  env: string;
  dryRun: boolean;
  yesFlag: boolean;
  nonInteractive: boolean;
  /** Runtime version string (from package.json) — required by the
   *  dispatcher's manifest handshake. Resolved in the outer scope so the
   *  phase body stays a pure await on `dispatch()`. */
  runtimeVersion: string;
}

/**
 * Phase output — JSON-serializable summary suitable for persistence as
 * `result` on phases/migrate.json. A future skip-already-applied (Phase 6)
 * could reconstruct the dispatch outcome without re-running by reading the
 * persisted externalRefs + this result.
 */
interface MigrateOutput {
  /** Status from the result artifact (applied | skipped | error | ...). */
  status: ResultArtifact['status'];
  /** Reason code from the result artifact (migration-applied,
   *  migration-disabled, env-not-configured, etc.). */
  reasonCode: string;
  /** List of migrations applied this run (empty on `skipped` / `error`). */
  appliedMigrations: string[];
  /** Operator-facing next-action hints surfaced by the skill. */
  nextActions: string[];
  /** Echoed env so the render layer / skip-already-applied has it. */
  env: string;
}

export async function runMigrate(options: MigrateCommandOptions = {}): Promise<{
  exitCode: number;
  /** Surfaced for the CLI dispatcher's `--json` payload callback. */
  result: ResultArtifact | null;
}> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  const envName = options.env ?? 'dev';
  const dryRun = options.dryRun ?? false;
  const yesFlag = options.yesFlag ?? false;
  const nonInteractive = options.nonInteractive ?? !process.stdin.isTTY;

  // Read package version for the runtime handshake. The CLI dispatcher used
  // to do this inline; we keep the same lookup shape so the engine-off path
  // is byte-for-byte identical to v6.0.7.
  const root = findPackageRoot(import.meta.url);
  let runtimeVersion = 'unknown';
  if (root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      runtimeVersion = pkg.version;
    } catch {
      /* fall through with 'unknown' — handshake will fail closed */
    }
  }

  const migrateInput: MigrateInput = {
    cwd,
    env: envName,
    dryRun,
    yesFlag,
    nonInteractive,
    runtimeVersion,
  };

  // Outer ref so the render path + the wrapper's --json envelope can
  // surface the full ResultArtifact (the JSON-serializable MigrateOutput
  // is a compact subset; the full artifact has nonce, contractVersion,
  // sideEffectsPerformed, etc. that callers may want).
  let resultArtifact: ResultArtifact | null = null;

  const dispatchFn = options.__testDispatch
    ?? (async (input: MigrateInput): Promise<ResultArtifact> => {
      return runMigrateDispatch({
        repoRoot: input.cwd,
        env: input.env,
        yesFlag: input.yesFlag,
        nonInteractive: input.nonInteractive,
        currentRuntimeVersion: input.runtimeVersion,
        dryRun: input.dryRun,
      });
    });

  // The wrapped phase body — calls the dispatcher and emits a
  // `migration-version` externalRef per applied migration. Engine-off
  // callers invoke this directly; engine-on callers route through
  // `runPhase()` which records ctx.emitExternalRef calls into
  // events.ndjson.
  const phase: RunPhase<MigrateInput, MigrateOutput> = {
    name: 'migrate',
    // See top-of-file rationale. The spec table at line 162 of
    // docs/specs/v6-run-state-engine.md declares idempotent: false
    // because dispatch output varies by ledger state — the v6.0.8
    // wrap matches that declaration. The underlying skill IS
    // ledger-guarded against double-apply; that's a property of the
    // skill, not of the phase contract. With `hasSideEffects: true`
    // and persisted `migration-version` externalRefs, Phase 6's
    // resume gate reads back the live migration_state to decide
    // skip-already-applied vs retry vs needs-human.
    idempotent: false,
    hasSideEffects: true,
    run: async (input, ctx) => {
      const artifact = await dispatchFn(input);
      resultArtifact = artifact;

      // Record one externalRef per applied migration. The id is shaped
      // `<env>:<migration_name>` so multi-env pipelines (dev → qa → prod)
      // can disambiguate the same migration across targets. Phase 6's
      // read-back rule will compare this set to the live ledger.
      for (const migration of artifact.appliedMigrations) {
        ctx.emitExternalRef({
          kind: 'migration-version',
          id: `${input.env}:${migration}`,
        });
      }

      return {
        status: artifact.status,
        reasonCode: artifact.reasonCode,
        appliedMigrations: artifact.appliedMigrations,
        nextActions: artifact.nextActions,
        env: input.env,
      };
    },
  };

  // v6.0.6+ — lifecycle wiring lives in `runPhaseWithLifecycle`. The
  // helper owns engine resolution, createRun, run.complete, state.json
  // refresh, and lock release. The caller just supplies the phase, the
  // input, the loaded config, and an engine-off escape hatch.
  let output: MigrateOutput;
  try {
    const lifecycleResult = await runPhaseWithLifecycle<MigrateInput, MigrateOutput>({
      cwd,
      phase,
      input: migrateInput,
      config,
      cliEngine: options.cliEngine,
      envEngine: options.envEngine,
      // Engine-off escape hatch — re-uses the same dispatchFn. We do
      // NOT thread a real ctx through here because the engine-off path
      // has no event ledger to write into; externalRefs only matter on
      // the engine path. The artifact still lands on `resultArtifact`
      // for the --json payload callback in the CLI dispatcher.
      runEngineOff: async () => {
        const artifact = await dispatchFn(migrateInput);
        resultArtifact = artifact;
        return {
          status: artifact.status,
          reasonCode: artifact.reasonCode,
          appliedMigrations: artifact.appliedMigrations,
          nextActions: artifact.nextActions,
          env: migrateInput.env,
        };
      },
    });
    output = lifecycleResult.output;
  } catch {
    // Helper already printed `[migrate] engine: phase failed — <msg>`
    // + the inspect hint, emitted run.complete failed, refreshed
    // state.json, released the lock. Surface the legacy non-zero exit.
    return { exitCode: 1, result: resultArtifact };
  }

  return {
    exitCode: renderMigrateOutput(output),
    result: resultArtifact,
  };
}

// ---------------------------------------------------------------------------
// Render — translate MigrateOutput back to the legacy stdout banner + exit
// code. Lives outside the wrapped phase because it's pure presentation; doing
// rendering inside the phase body would couple the engine path's idempotency
// to console output.
// ---------------------------------------------------------------------------

function renderMigrateOutput(output: MigrateOutput): number {
  const ok = output.status === 'applied' || output.status === 'skipped';
  const color = ok ? C.green : C.red;
  console.log(`${color}[migrate] status=${output.status} reason=${output.reasonCode}${C.reset}`);
  if (output.appliedMigrations.length > 0) {
    console.log(`  applied: ${output.appliedMigrations.join(', ')}`);
  }
  if (output.nextActions.length > 0) {
    console.log(`  next: ${output.nextActions.join('; ')}`);
  }
  // Suppress unused-helper TS warning when fmt isn't called above (the dim /
  // bold / cyan helpers are reserved for future render paths — keeping the
  // import + fmt() reference parallel with other wrapped verbs makes
  // bin-mods easier to read).
  void fmt;
  return ok ? 0 : 1;
}
