import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetDeployAdapterResolver,
  __resetMigrationStateFetcher,
  __resetMigrationBatchFetcher,
  getProviderReadbacks,
  makeDeployReadback,
  makeGithubReadback,
  makeSupabaseReadback,
  readbackForRef,
  registerDeployAdapterResolver,
  registerMigrationStateFetcher,
  registerMigrationBatchFetcher,
  setProviderReadbacks,
  verifyRefs,
  type DeployStatusFetcher,
  type MigrationStateFetcher,
  type MigrationBatchFetcher,
  type ProviderReadback,
} from '../../src/core/run-state/provider-readback.ts';
import type { ExternalRef } from '../../src/core/run-state/types.ts';

function ref(overrides: Partial<ExternalRef> = {}): ExternalRef {
  return {
    kind: 'github-pr',
    id: '99',
    provider: 'github',
    observedAt: '2026-05-04T00:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  setProviderReadbacks(null);
  __resetDeployAdapterResolver();
  __resetMigrationStateFetcher();
  __resetMigrationBatchFetcher();
});

describe('readbackForRef — registry lookup', () => {
  it('returns the github readback for github-pr refs', () => {
    const rb = readbackForRef(ref({ kind: 'github-pr' }));
    assert.equal(rb?.name, 'github');
  });

  it('returns the github readback for git-remote-push refs', () => {
    const rb = readbackForRef(ref({ kind: 'git-remote-push', id: 'abc123' }));
    assert.equal(rb?.name, 'github');
  });

  it('returns null when no readback handles the ref kind', () => {
    setProviderReadbacks([]);
    const rb = readbackForRef(ref());
    assert.equal(rb, null);
  });

  it('returns the supabase readback for migration-version refs', () => {
    const rb = readbackForRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(rb?.name, 'supabase');
  });

  it('default registry handles every Phase 6 ref kind that needs a readback', () => {
    // For provider-scoped kinds (deploy, rollback-target) the lookup is
    // (kind, provider) — caller must supply a provider matching one of the
    // registered deploy readbacks. Pick vercel as a representative provider.
    const cases: Array<{ kind: ExternalRef['kind']; provider?: string }> = [
      { kind: 'github-pr' },
      { kind: 'github-comment' },
      { kind: 'git-remote-push' },
      { kind: 'deploy', provider: 'vercel' },
      { kind: 'rollback-target', provider: 'vercel' },
      { kind: 'migration-version' },
    ];
    for (const { kind, provider } of cases) {
      const rb = readbackForRef(ref({ kind, ...(provider !== undefined ? { provider } : {}) }));
      assert.ok(rb, `no readback for kind=${kind} provider=${provider ?? '<none>'}`);
    }
  });

  it('first-match-wins on duplicate handlers (no provider allowlist)', () => {
    const a: ProviderReadback = {
      name: 'a',
      handles: ['github-pr'],
      verifyRef: async (r) => ({ refKind: r.kind, refId: r.id, existsOnPlatform: true, currentState: 'open' }),
    };
    const b: ProviderReadback = {
      name: 'b',
      handles: ['github-pr'],
      verifyRef: async (r) => ({ refKind: r.kind, refId: r.id, existsOnPlatform: true, currentState: 'closed' }),
    };
    setProviderReadbacks([a, b]);
    const rb = readbackForRef(ref({ kind: 'github-pr' }));
    assert.equal(rb?.name, 'a');
  });

  // Bugbot MEDIUM on PR #91: vercel/fly/render all declare
  // handles: ['deploy', 'rollback-target']. Before the fix, the first
  // registered (vercel) won every lookup and fly/render were dead code.
  // The registry now disambiguates by ref.provider when readbacks declare
  // a `providers` allowlist.
  it('Bugbot PR #91 — disambiguates duplicate kinds by ref.provider', () => {
    const r1 = readbackForRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r1?.name, 'vercel');
    const r2 = readbackForRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'fly' }));
    assert.equal(r2?.name, 'fly');
    const r3 = readbackForRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'render' }));
    assert.equal(r3?.name, 'render');
    const r4 = readbackForRef(ref({ kind: 'rollback-target', id: 'dpl_y', provider: 'fly' }));
    assert.equal(r4?.name, 'fly');
  });

  it('Bugbot PR #91 — unknown deploy provider returns null (not silent vercel match)', () => {
    const rb = readbackForRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'netlify' }));
    assert.equal(rb, null);
  });

  it('Bugbot PR #91 — kind-only readbacks (no `providers`) match regardless of ref.provider', () => {
    // The github readback handles github-pr without a `providers` allowlist —
    // its routing must not regress: refs with the matching kind always pick
    // it whether or not they declare a provider, including provider values
    // the readback never explicitly opted into.
    const r1 = readbackForRef(ref({ kind: 'github-pr', id: '1', provider: 'github' }));
    assert.equal(r1?.name, 'github');
    const r2 = readbackForRef(ref({ kind: 'github-pr', id: '2', provider: 'someone-else' }));
    assert.equal(r2?.name, 'github');
  });
});

describe('github readback — gh CLI parsing', () => {
  it('parses an OPEN PR into currentState=open + existsOnPlatform=true', async () => {
    const gh = makeGithubReadback({
      gh: () => JSON.stringify({ state: 'OPEN', url: 'https://github.com/x/y/pull/99', title: 't', merged: false }),
    });
    const r = await gh.verifyRef(ref({ kind: 'github-pr', id: '99' }));
    assert.equal(r.existsOnPlatform, true);
    assert.equal(r.currentState, 'open');
    assert.equal(r.refId, '99');
    assert.equal((r.metadata as { url?: string }).url, 'https://github.com/x/y/pull/99');
  });

  it('parses a MERGED PR (merged:true) into currentState=merged', async () => {
    const gh = makeGithubReadback({
      gh: () => JSON.stringify({ state: 'MERGED', merged: true }),
    });
    const r = await gh.verifyRef(ref({ kind: 'github-pr' }));
    assert.equal(r.currentState, 'merged');
  });

  it('parses a CLOSED-not-merged PR as currentState=closed', async () => {
    const gh = makeGithubReadback({
      gh: () => JSON.stringify({ state: 'CLOSED', merged: false }),
    });
    const r = await gh.verifyRef(ref({ kind: 'github-pr' }));
    assert.equal(r.currentState, 'closed');
  });

  it('fails closed when gh returns null (404, auth, network)', async () => {
    const gh = makeGithubReadback({ gh: () => null });
    const r = await gh.verifyRef(ref({ kind: 'github-pr' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed on unparseable JSON from gh', async () => {
    const gh = makeGithubReadback({ gh: () => 'not json at all' });
    const r = await gh.verifyRef(ref({ kind: 'github-pr' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed when gh impl throws (defense in depth)', async () => {
    const gh = makeGithubReadback({ gh: () => { throw new Error('boom'); } });
    const r = await gh.verifyRef(ref({ kind: 'github-pr' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('git-remote-push: gh api 404 → existsOnPlatform=false, currentState=closed', async () => {
    const gh = makeGithubReadback({ gh: () => null });
    const r = await gh.verifyRef(ref({ kind: 'git-remote-push', id: 'deadbeef' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'closed');
  });

  it('git-remote-push: gh api success returns sha → existsOnPlatform=true, currentState=live', async () => {
    const gh = makeGithubReadback({
      gh: () => JSON.stringify({ sha: 'deadbeef', html_url: 'https://github.com/x/y/commit/deadbeef' }),
    });
    const r = await gh.verifyRef(ref({ kind: 'git-remote-push', id: 'deadbeef' }));
    assert.equal(r.existsOnPlatform, true);
    assert.equal(r.currentState, 'live');
  });
});

describe('deploy readback — adapter status mock', () => {
  it('returns currentState=live for status=pass', async () => {
    const fetcher: DeployStatusFetcher = {
      status: async ({ deployId }) => ({ status: 'pass', deployId, deployUrl: 'https://x.vercel.app' }),
    };
    registerDeployAdapterResolver(() => fetcher);
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.existsOnPlatform, true);
    assert.equal(r.currentState, 'live');
    assert.equal((r.metadata as { deployUrl?: string }).deployUrl, 'https://x.vercel.app');
  });

  it('returns currentState=rolled-back for status=fail_rolled_back', async () => {
    registerDeployAdapterResolver(() => ({
      status: async ({ deployId }) => ({ status: 'fail_rolled_back', deployId }),
    }));
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.currentState, 'rolled-back');
  });

  it('returns currentState=failed for status=fail', async () => {
    registerDeployAdapterResolver(() => ({
      status: async ({ deployId }) => ({ status: 'fail', deployId }),
    }));
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.currentState, 'failed');
  });

  it('fails closed when adapter throws', async () => {
    registerDeployAdapterResolver(() => ({
      status: async () => { throw new Error('adapter exploded'); },
    }));
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed when no adapter resolver is registered', async () => {
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed when ref provider does not match readback providers', async () => {
    registerDeployAdapterResolver(() => ({
      status: async ({ deployId }) => ({ status: 'pass', deployId }),
    }));
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'fly' }));
    assert.equal(r.currentState, 'unknown');
    assert.equal((r.metadata as { reason?: string }).reason, 'provider-mismatch');
  });

  it('fails closed when adapter resolver returns null', async () => {
    registerDeployAdapterResolver(() => null);
    const rb = makeDeployReadback('vercel', ['vercel']);
    const r = await rb.verifyRef(ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }));
    assert.equal(r.currentState, 'unknown');
  });
});

describe('supabase readback — migration_state', () => {
  it('returns currentState=live when migration is applied', async () => {
    const fetcher: MigrationStateFetcher = {
      fetch: async () => ({ applied: true, appliedAt: '2026-05-04T00:00:00Z' }),
    };
    registerMigrationStateFetcher(fetcher);
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(r.existsOnPlatform, true);
    assert.equal(r.currentState, 'live');
  });

  it('returns currentState=open when migration is pending (not applied)', async () => {
    registerMigrationStateFetcher({ fetch: async () => ({ applied: false }) });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(r.currentState, 'open');
  });

  it('fails closed when fetcher returns null (not found / error)', async () => {
    registerMigrationStateFetcher({ fetch: async () => null });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(r.existsOnPlatform, false);
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed when fetcher throws', async () => {
    registerMigrationStateFetcher({ fetch: async () => { throw new Error('db down'); } });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(r.currentState, 'unknown');
  });

  it('fails closed when no fetcher is registered', async () => {
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-version', id: '20260504_init' }));
    assert.equal(r.currentState, 'unknown');
  });
});

describe('verifyRefs — bulk verification', () => {
  it('returns one result per ref in order, fail-closed for unhandled kinds', async () => {
    const gh = makeGithubReadback({
      gh: () => JSON.stringify({ state: 'OPEN', merged: false }),
    });
    setProviderReadbacks([gh]);
    const refs: ExternalRef[] = [
      ref({ kind: 'github-pr', id: '1' }),
      ref({ kind: 'deploy', id: 'dpl_x', provider: 'vercel' }), // no readback registered
      ref({ kind: 'github-pr', id: '2' }),
    ];
    const results = await verifyRefs(refs);
    assert.equal(results.length, 3);
    assert.equal(results[0]?.currentState, 'open');
    assert.equal(results[1]?.currentState, 'unknown');
    assert.equal(results[2]?.currentState, 'open');
  });

  it('runs verifications in parallel without crashing on any one failure', async () => {
    const gh = makeGithubReadback({
      gh: () => { throw new Error('always-throws'); },
    });
    setProviderReadbacks([gh]);
    const refs: ExternalRef[] = [
      ref({ kind: 'github-pr', id: '1' }),
      ref({ kind: 'github-pr', id: '2' }),
    ];
    const results = await verifyRefs(refs);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.existsOnPlatform, false);
      assert.equal(r.currentState, 'unknown');
    }
  });
});

describe('default registry sanity', () => {
  it('exposes 5 default readbacks: github, vercel, fly, render, supabase', () => {
    const list = getProviderReadbacks();
    const names = list.map(rb => rb.name).sort();
    assert.deepEqual(names, ['fly', 'github', 'render', 'supabase', 'vercel']);
  });
});

// ---------------------------------------------------------------------------
// v6.2.1 — migration-batch readback. Maps the planned set + ledger state
// onto the canonical state vocabulary: merged / open / failed / unknown.
// ---------------------------------------------------------------------------

describe('supabase migration-batch readback (v6.2.1)', () => {
  it('all planned migrations applied → merged', async () => {
    const fetcher: MigrationBatchFetcher = {
      fetch: async () => ({
        planned: [
          { version: 'm1', state: 'applied' },
          { version: 'm2', state: 'applied' },
          { version: 'm3', state: 'applied' },
        ],
      }),
    };
    registerMigrationBatchFetcher(fetcher);
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.existsOnPlatform, true);
    assert.equal(r.currentState, 'merged');
  });

  it('some planned migrations pending → open', async () => {
    registerMigrationBatchFetcher({
      fetch: async () => ({
        planned: [
          { version: 'm1', state: 'applied' },
          { version: 'm2', state: 'pending' },
          { version: 'm3', state: 'pending' },
        ],
      }),
    });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'open');
  });

  it('any errored migration → failed', async () => {
    registerMigrationBatchFetcher({
      fetch: async () => ({
        planned: [
          { version: 'm1', state: 'applied' },
          { version: 'm2', state: 'errored' },
        ],
      }),
    });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'failed');
  });

  it('empty planned set → merged (degenerate case, not a wedge)', async () => {
    registerMigrationBatchFetcher({
      fetch: async () => ({ planned: [] }),
    });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'merged');
  });

  it('fetcher returns null → unknown (fail closed)', async () => {
    registerMigrationBatchFetcher({ fetch: async () => null });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'unknown');
  });

  it('fetcher throws → unknown (fail closed)', async () => {
    registerMigrationBatchFetcher({ fetch: async () => { throw new Error('boom'); } });
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'unknown');
  });

  it('no fetcher registered → unknown', async () => {
    const rb = makeSupabaseReadback();
    const r = await rb.verifyRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(r.currentState, 'unknown');
  });

  it('default registry routes migration-batch refs to supabase readback', () => {
    const rb = readbackForRef(ref({ kind: 'migration-batch', id: 'qa:hash' }));
    assert.equal(rb?.name, 'supabase');
  });
});
