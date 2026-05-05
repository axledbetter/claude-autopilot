// src/core/run-state/provider-readback.ts
//
// v6 Phase 6 — pluggable provider read-back layer.
//
// When the run-state engine resumes a run that has prior `phase.success` +
// side-effects + persisted `externalRefs`, the replay decision (see
// `replay-decision.ts`) is NOT pure — it MUST consult the platform of record
// to confirm the ref is still live and in the expected state. e.g. for a
// `github-pr` ref we ask `gh pr view <id> --json state` and inspect
// open / closed / merged. For a `deploy` ref we ask the adapter's `status()`.
//
// This file is the seam: a `ProviderReadback` interface, a registry mapping
// `ExternalRef.kind` to an implementation, and the built-in readbacks for
// github / vercel / fly / render / supabase. Each readback FAILS CLOSED — any
// throw or unrecognized response shape is recorded as
// `existsOnPlatform: false, currentState: 'unknown'`. Callers (the replay
// decision matrix) treat unknown-state as `needs-human` so we never quietly
// overwrite or duplicate a side effect on a missing/stale ref.
//
// Spec: docs/specs/v6-run-state-engine.md "Idempotency rules + external
// operation ledger (Codex CRITICAL #2)" — replay decision is "persisted refs
// + a provider read-back check (e.g., 'is PR #123 still open?')".

import type { ExternalRef, ExternalRefKind } from './types.ts';
import { runSafe } from '../shell.ts';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Canonical platform-state vocabulary. Every readback maps its provider's
 *  raw state into one of these so the decision matrix stays provider-agnostic.
 *  `unknown` is the fail-closed sentinel — any time the readback can't make a
 *  confident assertion it returns `unknown` and the caller treats that as
 *  needs-human. */
export type ReadbackState =
  | 'open'         // PR/comment open, deploy live, migration pending
  | 'closed'       // PR closed without merge, comment deleted
  | 'merged'       // PR merged
  | 'live'         // deploy currently serving traffic
  | 'failed'       // deploy failed, migration errored
  | 'rolled-back'  // deploy was rolled back to a prior version
  | 'unknown';     // readback could not determine — fail closed

/** What a readback returns when asked to verify a single external ref. */
export interface ReadbackResult {
  refKind: ExternalRefKind;
  refId: string;
  /** Whether the platform reports the ref still exists. False on 404,
   *  hard error, missing ID, or any throw. */
  existsOnPlatform: boolean;
  currentState: ReadbackState;
  /** Free-form provider-specific metadata. Engine doesn't introspect.
   *  Surfaces in the replay decision's `details` for human triage. */
  metadata?: Record<string, unknown>;
}

/** A readback verifies one ref kind against its source-of-truth platform.
 *  Implementations MUST NOT throw — any failure (network, auth, unknown
 *  shape) collapses to `existsOnPlatform: false, currentState: 'unknown'`.
 *  This is the fail-closed contract: an unknown-state readback always
 *  routes to needs-human, never to a silent skip-already-applied. */
export interface ProviderReadback {
  /** Stable identifier — useful in logs / decision details. */
  readonly name: string;
  /** Which ref kinds this readback handles. The registry filters first by
   *  kind; if multiple entries match a kind, `providers` then disambiguates
   *  on `ref.provider`. */
  readonly handles: ReadonlyArray<ExternalRefKind>;
  /** Optional provider-name allowlist. When present, the registry only
   *  routes a ref to this readback if `ref.provider` is in this list. Lets
   *  multiple readbacks share a kind (e.g. vercel/fly/render all handle
   *  `deploy`) without shadowing each other. Omit for kind-exclusive
   *  readbacks (e.g. github handles `github-pr`). */
  readonly providers?: ReadonlyArray<string>;
  verifyRef(ref: ExternalRef): Promise<ReadbackResult>;
}

// ---------------------------------------------------------------------------
// Wrapping helper — guarantees the fail-closed contract regardless of impl.
// ---------------------------------------------------------------------------

/** Wrap a readback so that any throw collapses to the unknown-state result.
 *  All built-in readbacks below opt into this; external implementations are
 *  free to use it too. Centralizes the fail-closed invariant. */
function failClosed(
  name: string,
  ref: ExternalRef,
  fn: () => Promise<ReadbackResult>,
): Promise<ReadbackResult> {
  return fn().catch(() => unknownResult(ref, { readback: name, threw: true }));
}

/** Build a fail-closed result for a ref that the readback couldn't verify. */
function unknownResult(
  ref: ExternalRef,
  metadata?: Record<string, unknown>,
): ReadbackResult {
  return {
    refKind: ref.kind,
    refId: ref.id,
    existsOnPlatform: false,
    currentState: 'unknown',
    ...(metadata ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// GitHub readback — uses `gh` CLI via runSafe (no auth handling here).
// ---------------------------------------------------------------------------

/** Test seam — replace the gh CLI invocation in tests without monkey-patching
 *  child_process. Returns null on any failure (matches runSafe semantics). */
export interface GhRunner {
  (args: string[]): string | null;
}

const defaultGhRunner: GhRunner = (args) => runSafe('gh', args, { timeout: 30000 });

export function makeGithubReadback(opts: { gh?: GhRunner } = {}): ProviderReadback {
  const gh = opts.gh ?? defaultGhRunner;
  return {
    name: 'github',
    handles: ['github-pr', 'github-comment', 'git-remote-push'],
    verifyRef: (ref) => failClosed('github', ref, async () => {
      if (ref.kind === 'github-pr') return verifyGithubPr(gh, ref);
      if (ref.kind === 'github-comment') return verifyGithubComment(gh, ref);
      if (ref.kind === 'git-remote-push') return verifyGitRemotePush(gh, ref);
      return unknownResult(ref, { readback: 'github', reason: 'unsupported-kind' });
    }),
  };
}

async function verifyGithubPr(gh: GhRunner, ref: ExternalRef): Promise<ReadbackResult> {
  // `gh pr view <id> --json state,url,title,merged` — single deterministic
  // call. PR ID may be a bare number ("99") or a full URL.
  const out = gh(['pr', 'view', ref.id, '--json', 'state,url,title,merged']);
  if (out === null) return unknownResult(ref, { readback: 'github-pr', reason: 'gh-cli-failed' });
  let parsed: { state?: string; url?: string; title?: string; merged?: boolean };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return unknownResult(ref, { readback: 'github-pr', reason: 'unparseable-json' });
  }
  // Map gh's state vocabulary onto ours. gh returns OPEN | CLOSED | MERGED.
  // `merged: true` overrides — a closed-merged PR is "merged", not "closed".
  let currentState: ReadbackState;
  if (parsed.merged === true || parsed.state === 'MERGED') currentState = 'merged';
  else if (parsed.state === 'OPEN') currentState = 'open';
  else if (parsed.state === 'CLOSED') currentState = 'closed';
  else currentState = 'unknown';
  return {
    refKind: ref.kind,
    refId: ref.id,
    existsOnPlatform: true,
    currentState,
    metadata: {
      readback: 'github-pr',
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
      rawState: parsed.state,
    },
  };
}

async function verifyGithubComment(gh: GhRunner, ref: ExternalRef): Promise<ReadbackResult> {
  // gh doesn't have a clean per-comment-ID lookup — we use `gh api` against
  // the issues comments endpoint. Comment IDs are integers; if the ref id is
  // qualified as `<repo>:<id>` we split, else we rely on cwd's repo context.
  let endpoint: string;
  if (ref.id.includes(':')) {
    const [repo, commentId] = ref.id.split(':', 2);
    endpoint = `/repos/${repo}/issues/comments/${commentId}`;
  } else {
    endpoint = `/repos/{owner}/{repo}/issues/comments/${ref.id}`;
  }
  const out = gh(['api', endpoint]);
  if (out === null) {
    // gh api returns non-zero on 404. Treat as does-not-exist (which is
    // distinct from unknown — a deleted comment is meaningful: replay would
    // create a new comment, so the prior ref is no longer authoritative).
    return {
      refKind: ref.kind,
      refId: ref.id,
      existsOnPlatform: false,
      currentState: 'closed',
      metadata: { readback: 'github-comment', reason: 'gh-api-failed-or-404' },
    };
  }
  let parsed: { id?: number; html_url?: string };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return unknownResult(ref, { readback: 'github-comment', reason: 'unparseable-json' });
  }
  return {
    refKind: ref.kind,
    refId: ref.id,
    existsOnPlatform: typeof parsed.id === 'number',
    currentState: typeof parsed.id === 'number' ? 'open' : 'unknown',
    metadata: {
      readback: 'github-comment',
      ...(parsed.html_url ? { url: parsed.html_url } : {}),
    },
  };
}

async function verifyGitRemotePush(gh: GhRunner, ref: ExternalRef): Promise<ReadbackResult> {
  // For a git-remote-push ref the id is the commit SHA. We confirm it exists
  // on the remote by asking gh for the commit. Treat "not found" as
  // does-not-exist (rebased away), distinct from unknown (auth/network).
  // gh api format: /repos/{owner}/{repo}/commits/<sha>.
  const out = gh(['api', `/repos/{owner}/{repo}/commits/${ref.id}`]);
  if (out === null) {
    return {
      refKind: ref.kind,
      refId: ref.id,
      existsOnPlatform: false,
      currentState: 'closed',
      metadata: { readback: 'git-remote-push', reason: 'gh-api-failed-or-404' },
    };
  }
  let parsed: { sha?: string; html_url?: string };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return unknownResult(ref, { readback: 'git-remote-push', reason: 'unparseable-json' });
  }
  return {
    refKind: ref.kind,
    refId: ref.id,
    existsOnPlatform: typeof parsed.sha === 'string',
    currentState: typeof parsed.sha === 'string' ? 'live' : 'unknown',
    metadata: {
      readback: 'git-remote-push',
      ...(parsed.html_url ? { url: parsed.html_url } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Deploy readbacks — call existing adapters' status() shape. We don't import
// concrete adapters (avoid loading every transport at module init); instead
// callers register an adapter resolver via `registerDeployAdapterResolver`.
// ---------------------------------------------------------------------------

/** Minimal adapter-status surface. Mirrors `DeployAdapter.status()` from
 *  `src/adapters/deploy/types.ts` but typed locally so this module doesn't
 *  pull the adapter package at init time. */
export interface DeployStatusFetcher {
  status(input: { deployId: string }): Promise<{
    status: 'pass' | 'fail' | 'in-progress' | 'fail_rolled_back' | 'fail_rollback_failed';
    deployId: string;
    deployUrl?: string;
  }>;
}

export type DeployAdapterResolver = (provider: string) => DeployStatusFetcher | null;

let deployAdapterResolver: DeployAdapterResolver | null = null;

/** Register a resolver that maps a provider name (e.g. "vercel") to a
 *  status-fetcher. The CLI wires this from `src/adapters/deploy/index.ts`
 *  during boot; tests inject mocks directly. */
export function registerDeployAdapterResolver(resolver: DeployAdapterResolver | null): void {
  deployAdapterResolver = resolver;
}

/** Reset the registered resolver. Test-only seam. */
export function __resetDeployAdapterResolver(): void {
  deployAdapterResolver = null;
}

export function makeDeployReadback(name: string, providers: ReadonlyArray<string>): ProviderReadback {
  return {
    name,
    handles: ['deploy', 'rollback-target'],
    providers,
    verifyRef: (ref) => failClosed(name, ref, async () => {
      const provider = ref.provider ?? null;
      if (!provider || !providers.includes(provider)) {
        return unknownResult(ref, {
          readback: name,
          reason: 'provider-mismatch',
          refProvider: provider,
        });
      }
      if (!deployAdapterResolver) {
        return unknownResult(ref, {
          readback: name,
          reason: 'no-adapter-resolver-registered',
        });
      }
      const fetcher = deployAdapterResolver(provider);
      if (!fetcher) {
        return unknownResult(ref, {
          readback: name,
          reason: 'adapter-not-resolvable',
          provider,
        });
      }
      const r = await fetcher.status({ deployId: ref.id });
      // Map adapter status → ReadbackState. The adapter contract returns
      // 'pass'|'fail'|'in-progress'|'fail_rolled_back'|'fail_rollback_failed'.
      let currentState: ReadbackState;
      switch (r.status) {
        case 'pass':
          currentState = 'live';
          break;
        case 'fail':
        case 'fail_rollback_failed':
          currentState = 'failed';
          break;
        case 'fail_rolled_back':
          currentState = 'rolled-back';
          break;
        case 'in-progress':
          currentState = 'open';
          break;
        default:
          currentState = 'unknown';
      }
      return {
        refKind: ref.kind,
        refId: ref.id,
        existsOnPlatform: true,
        currentState,
        metadata: {
          readback: name,
          provider,
          rawStatus: r.status,
          ...(r.deployUrl ? { deployUrl: r.deployUrl } : {}),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Supabase migration readback — queries `migration_state` per-env config.
// ---------------------------------------------------------------------------

/** Minimal migration-state fetcher. Implementations query the per-env
 *  Supabase project's `migration_state` table. We type it abstractly so this
 *  module doesn't pull the supabase client at init time. Returning null
 *  indicates "fetch failed" — fail-closed treats it as unknown. */
export interface MigrationStateFetcher {
  /** Look up a migration version. Returns null on any error or not-found. */
  fetch(version: string): Promise<{ applied: boolean; appliedAt?: string } | null>;
}

let migrationStateFetcher: MigrationStateFetcher | null = null;

/** Register the migration-state fetcher used by the supabase readback.
 *  CLI boot wires this; tests inject directly. */
export function registerMigrationStateFetcher(fetcher: MigrationStateFetcher | null): void {
  migrationStateFetcher = fetcher;
}

export function __resetMigrationStateFetcher(): void {
  migrationStateFetcher = null;
}

export function makeSupabaseReadback(): ProviderReadback {
  return {
    name: 'supabase',
    handles: ['migration-version'],
    verifyRef: (ref) => failClosed('supabase', ref, async () => {
      if (!migrationStateFetcher) {
        return unknownResult(ref, {
          readback: 'supabase',
          reason: 'no-migration-state-fetcher-registered',
        });
      }
      const result = await migrationStateFetcher.fetch(ref.id);
      if (!result) {
        return unknownResult(ref, {
          readback: 'supabase',
          reason: 'migration-state-fetch-failed-or-not-found',
        });
      }
      return {
        refKind: ref.kind,
        refId: ref.id,
        existsOnPlatform: true,
        currentState: result.applied ? 'live' : 'open',
        metadata: {
          readback: 'supabase',
          applied: result.applied,
          ...(result.appliedAt ? { appliedAt: result.appliedAt } : {}),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Registry — first-match-wins lookup keyed on ExternalRefKind.
// ---------------------------------------------------------------------------

/** Default built-in registry. Order matters: first readback whose `handles`
 *  contains the ref kind wins. Callers may swap individual entries via
 *  `setProviderReadbacks` (test-only seam). */
function buildDefaultRegistry(): ProviderReadback[] {
  return [
    makeGithubReadback(),
    makeDeployReadback('vercel', ['vercel']),
    makeDeployReadback('fly', ['fly']),
    makeDeployReadback('render', ['render']),
    makeSupabaseReadback(),
  ];
}

let providerReadbacks: ProviderReadback[] = buildDefaultRegistry();

/** Live registry — exposed as a getter so tests / callers can introspect. */
export function getProviderReadbacks(): ReadonlyArray<ProviderReadback> {
  return providerReadbacks;
}

/** Replace the registry (test seam). Pass null to reset to defaults. */
export function setProviderReadbacks(list: ProviderReadback[] | null): void {
  providerReadbacks = list === null ? buildDefaultRegistry() : list;
}

/** Look up the readback that handles a given ref. Two-pass match: first try
 *  a strict (kind + provider) match so multiple readbacks sharing a kind
 *  (vercel/fly/render all on `deploy`) don't shadow each other; then fall
 *  back to a kind-only match for readbacks that don't declare a provider
 *  allowlist (e.g. the github readback handles `github-pr` regardless of
 *  ref.provider). Returns null if no registered readback claims this ref —
 *  caller treats null as "no readback available, route to needs-human".
 *
 *  Bugbot MEDIUM (PR #91): without provider-aware matching, the first deploy
 *  readback registered (vercel) won every `deploy`/`rollback-target` lookup
 *  and the fly/render readbacks were dead code. */
export function readbackForRef(ref: ExternalRef): ProviderReadback | null {
  if (ref.provider) {
    for (const rb of providerReadbacks) {
      if (rb.handles.includes(ref.kind) && rb.providers?.includes(ref.provider)) return rb;
    }
  }
  for (const rb of providerReadbacks) {
    if (rb.handles.includes(ref.kind) && !rb.providers) return rb;
  }
  return null;
}

/** Verify a list of refs in parallel. Returns one ReadbackResult per ref.
 *  Refs without a registered readback get an unknown-state result so the
 *  decision matrix can attribute the gap. Order is preserved. */
export async function verifyRefs(refs: ReadonlyArray<ExternalRef>): Promise<ReadbackResult[]> {
  return Promise.all(refs.map(async (ref) => {
    const rb = readbackForRef(ref);
    if (!rb) return unknownResult(ref, { reason: 'no-readback-registered' });
    return rb.verifyRef(ref);
  }));
}
