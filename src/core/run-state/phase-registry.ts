// src/core/run-state/phase-registry.ts
//
// v6.2.0 — typed phase registry for the multi-phase orchestrator.
//
// The new top-level `claude-autopilot autopilot` verb (see src/cli/autopilot.ts)
// drives N phases under one runId. To do that without losing per-phase I/O
// types it needs a typed registry: `name → builder` where the builder's
// `RunPhase<I, O>` shape is preserved through dynamic dispatch. The naive
// `Record<PhaseName, PhaseRegistration<unknown, unknown>>` shape would
// collapse every entry to `unknown`-on-both-sides, defeating the purpose
// of the v6 phase contract.
//
// The trick (per codex NOTE #5 on the v6.2 spec):
//   - Each entry is annotated with `satisfies PhaseRegistration<I, O>` to
//     force-check that the builder returns the correct shape.
//   - The wrapping `as const` preserves the literal `name → entry` pairs so
//     `keyof typeof PHASE_REGISTRY` is the literal union, not a generic
//     `string`.
//   - Per-entry I/O types stay reachable through TypeScript's structural
//     inference on the satisfies constraint.
//
// v6.2.0 ships with FOUR registered phases: `scan`, `spec`, `plan`,
// `implement`. The remaining six pipeline verbs (`brainstorm`, `costs`,
// `fix`, `review`, `validate`) are intentionally unregistered for v6.2.0:
//
//   - `migrate` and `pr` need explicit per-phase idempotency contracts
//     (preflight readback + externalRef recorded BEFORE the side-effect)
//     before they can land in a multi-phase orchestrator. v6.2.1 gates on
//     those contracts.
//   - `brainstorm`, `costs`, `fix`, `review`, `validate` are advisory /
//     read-only verbs that don't fit the pipeline shape (per spec
//     "phase ordering" section). Users who want them in a custom run
//     should compose them via the eventual `--phases=<csv>` option once
//     they are extracted in a follow-up release.
//
// Spec: docs/specs/v6.2-multi-phase-orchestrator.md "Phase registry".

import type { GuardrailConfig } from '../config/types.ts';
import type { RunPhase } from './phase-runner.ts';
import type { ExternalRefKind } from './types.ts';

import {
  buildScanPhase,
  type ScanInput,
  type ScanOutput,
  type ScanCommandOptions,
} from '../../cli/scan.ts';
import {
  buildSpecPhase,
  type SpecInput,
  type SpecOutput,
  type SpecCommandOptions,
} from '../../cli/spec.ts';
import {
  buildPlanPhase,
  type PlanInput,
  type PlanOutput,
  type PlanCommandOptions,
} from '../../cli/plan.ts';
import {
  buildImplementPhase,
  type ImplementInput,
  type ImplementOutput,
  type ImplementCommandOptions,
} from '../../cli/implement.ts';
import {
  buildMigratePhase,
  type MigrateInput,
  type MigrateOutput,
  type MigrateCommandOptions,
} from '../../cli/migrate.ts';
import {
  buildPrPhase,
  type PrInput,
  type PrOutput,
  type PrCommandOptions,
} from '../../cli/pr.ts';

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

/** v6.2.0 — early-exit sentinel returned by a builder when the verb's
 *  pre-flight (no targets, no LLM key, dry-run, …) decided it can exit
 *  without running through the engine lifecycle. The orchestrator surfaces
 *  this exit code straight through and short-circuits — no further phases
 *  run, no `run.complete` event is emitted (we never created a run dir
 *  in this branch). */
export interface PhaseEarlyExit {
  kind: 'early-exit';
  exitCode: number;
}

/** Result of a successful builder call. Carries everything the orchestrator
 *  needs to drive a single-phase `runPhase` invocation. */
export interface PhaseBuilt<I, O> {
  kind: 'phase';
  phase: RunPhase<I, O>;
  input: I;
  /** Loaded `guardrail.config.yaml` (or the default). The orchestrator
   *  uses this for `engine.enabled` resolution; per-phase wrappers also
   *  forward it to `runPhaseWithLifecycle`. */
  config: GuardrailConfig;
  /** Translate the phase output back into the legacy stdout banner +
   *  exit code path. The orchestrator calls this once per phase after
   *  `runPhase` returns. */
  renderResult: (output: O) => number;
}

/** Each registered phase defines a `build(deps)` that produces either a
 *  `PhaseBuilt` (the happy path) or a `PhaseEarlyExit` (pre-flight bailed).
 *  The generic `<I, O>` is preserved at the declaration site via
 *  `satisfies PhaseRegistration<I, O>` so the registry doesn't collapse
 *  to `PhaseRegistration<unknown, unknown>` on lookup.
 *
 *  v6.2.1 — `preEffectRefKinds` and `postEffectRefKinds` capture the per-
 *  phase idempotency contract. A side-effecting phase MUST declare both:
 *  the registry rejects any `hasSideEffects: true` registration that omits
 *  them. The orchestrator's resume preflight reads them back to decide
 *  skip-already-applied vs retry vs needs-human. Read-only phases (scan /
 *  spec / plan / implement-as-of-v6.2.0) omit both — they never enter the
 *  preflight branch.
 *
 *  The kinds named here MUST be subsets of `ExternalRefKind`. The registry
 *  doesn't statically verify the phase body emits them (would require
 *  runtime introspection of `ctx.emitExternalRef` calls); it only requires
 *  the contract DECLARATION so the orchestrator knows what to read back. */
export interface PhaseRegistration<I, O, Opts = unknown> {
  build: (deps: Opts) => Promise<PhaseBuilt<I, O> | PhaseEarlyExit>;
  /** Human-readable name shown in CLI banners + `runs show` output. */
  displayName: string;
  /** v6.2.1 — true iff the registered phase declares `hasSideEffects: true`
   *  on its `RunPhase` shape. Required so the registry's `registerPhase`
   *  helper can enforce the side-effect idempotency contract at registration
   *  time without needing to instantiate the phase. Read-only phases
   *  (scan / spec / plan / implement) omit this or set it to false. */
  hasSideEffects?: boolean;
  /** v6.2.1 — kinds the phase emits BEFORE invoking its side effect. Used
   *  by the orchestrator's resume preflight to detect "we started this work
   *  but didn't finish." Required when `hasSideEffects: true`. */
  preEffectRefKinds?: readonly ExternalRefKind[];
  /** v6.2.1 — kinds the phase emits AFTER its side effect completes
   *  successfully. Used by the resume preflight's skip-already-applied
   *  check (all post-effect refs `merged`/`live` ⇒ skip). Required when
   *  `hasSideEffects: true`; may be empty when the pre-effect ref doubles
   *  as the reconciliation ref (e.g. `pr`'s `github-pr` is recorded
   *  pre-effect with the same id `gh` reports post-create). */
  postEffectRefKinds?: readonly ExternalRefKind[];
}

/**
 * v6.2.1 — registry-time guard that enforces the side-effect idempotency
 * contract. Throws `Error` (caught by the registry-rejection test) when a
 * `hasSideEffects: true` registration omits the contract arrays.
 *
 * Why a runtime throw and not a type-level check: the contract arrays are
 * declarative metadata, not type-derivable from the builder signature. A
 * structural type constraint would require duplicating each builder's
 * shape into a wider type — overkill for a one-line registry-time check
 * that runs once at module load.
 */
export function registerPhase<I, O, Opts = unknown>(
  reg: PhaseRegistration<I, O, Opts>,
): PhaseRegistration<I, O, Opts> {
  if (reg.build === undefined) {
    throw new Error(`registry: missing build for ${reg.displayName}`);
  }
  if (reg.hasSideEffects) {
    const pre = reg.preEffectRefKinds;
    const post = reg.postEffectRefKinds;
    if (!pre || pre.length === 0 || !post) {
      throw new Error(
        `registry: side-effect phase ${reg.displayName} missing idempotency contract — ` +
        `declare preEffectRefKinds + postEffectRefKinds`,
      );
    }
  }
  return reg;
}

// ---------------------------------------------------------------------------
// The actual registry
// ---------------------------------------------------------------------------

/** v6.2.0 — phase registry. `as const` preserves the literal name → entry
 *  pairs; `satisfies` per-entry validates the builder signature without
 *  collapsing the inferred shape.
 *
 *  Adding a new phase: extract its `build<Phase>Phase()` builder out of the
 *  CLI verb (parity test required — see spec WARNING #4), then register
 *  here. The orchestrator picks it up automatically.
 *
 *  v6.2.1 — `migrate` and `pr` enter the registry. Both are side-effecting,
 *  so each declares its idempotency contract via `preEffectRefKinds` /
 *  `postEffectRefKinds`. `registerPhase()` runs at module load and throws
 *  if a side-effect entry omits the contract — that's the registry-time
 *  enforcement gate the v6.2.1 spec requires. Read-only phases (scan /
 *  spec / plan / implement) omit both arrays. */
export const PHASE_REGISTRY = {
  scan: registerPhase({
    build: buildScanPhase,
    displayName: 'Scan',
  }) satisfies PhaseRegistration<ScanInput, ScanOutput, ScanCommandOptions>,
  spec: registerPhase({
    build: buildSpecPhase,
    displayName: 'Spec',
  }) satisfies PhaseRegistration<SpecInput, SpecOutput, SpecCommandOptions>,
  plan: registerPhase({
    build: buildPlanPhase,
    displayName: 'Plan',
  }) satisfies PhaseRegistration<PlanInput, PlanOutput, PlanCommandOptions>,
  implement: registerPhase({
    build: buildImplementPhase,
    displayName: 'Implement',
  }) satisfies PhaseRegistration<ImplementInput, ImplementOutput, ImplementCommandOptions>,
  migrate: registerPhase({
    build: buildMigratePhase,
    displayName: 'Migrate',
    hasSideEffects: true,
    preEffectRefKinds: ['migration-batch'],
    postEffectRefKinds: ['migration-version'],
  }) satisfies PhaseRegistration<MigrateInput, MigrateOutput, MigrateCommandOptions>,
  pr: registerPhase({
    build: buildPrPhase,
    displayName: 'PR',
    hasSideEffects: true,
    // The github-pr ref is recorded pre-effect with the same id gh reports
    // post-create — it serves both purposes. postEffectRefKinds is empty
    // by design, not by omission. The contract guard accepts an empty
    // array; only `undefined` triggers the rejection.
    preEffectRefKinds: ['github-pr'],
    postEffectRefKinds: [],
  }) satisfies PhaseRegistration<PrInput, PrOutput, PrCommandOptions>,
} as const;

/** Literal union of registered phase names. Adding a new phase to
 *  PHASE_REGISTRY automatically extends this type. */
export type PhaseName = keyof typeof PHASE_REGISTRY;

/** The default `--mode=full` ordering. v6.2.0 shipped scan → spec → plan →
 *  implement; v6.2.1 extends with migrate → pr (per spec section "Phase
 *  ordering"). After v6.2.1 ships, `claude-autopilot autopilot` runs the
 *  full 6-phase pipeline under one runId. */
export const DEFAULT_FULL_PHASES: readonly PhaseName[] = [
  'scan',
  'spec',
  'plan',
  'implement',
  'migrate',
  'pr',
] as const;

/** Look up a phase entry by name. Returns the registration with its full
 *  typed shape preserved (the `as const` + `satisfies` pattern means the
 *  caller can still reach `PhaseInput<'scan'>` even though the lookup is
 *  dynamic). Throws if the name is not registered — callers that want a
 *  graceful fallback should validate against `PHASE_REGISTRY` keys
 *  beforehand (see `validatePhaseNames` below). */
export function getPhase<N extends PhaseName>(name: N): typeof PHASE_REGISTRY[N] {
  const entry = PHASE_REGISTRY[name];
  if (!entry) {
    throw new Error(
      `[phase-registry] unknown phase: "${name}". Registered: ${listPhaseNames().join(', ')}`,
    );
  }
  return entry;
}

/** All registered phase names in declaration order. Useful for `--help`
 *  text and pre-flight `--phases` validation. */
export function listPhaseNames(): readonly PhaseName[] {
  return Object.keys(PHASE_REGISTRY) as PhaseName[];
}

/** Validate a user-supplied list of phase names against the registry.
 *  Returns the unknown names (empty array on full match) so the caller
 *  can produce a clear `invalid_config` error before any run dir is
 *  created. */
export function validatePhaseNames(
  names: readonly string[],
): { ok: true } | { ok: false; unknown: string[] } {
  const known = new Set<string>(listPhaseNames());
  const unknown = names.filter(n => !known.has(n));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true };
}
