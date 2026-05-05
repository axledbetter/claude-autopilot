import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetDeployAdapterResolver,
  __resetMigrationStateFetcher,
  getProviderReadbacks,
  makeDeployReadback,
  makeGithubReadback,
  makeSupabaseReadback,
  readbackForRef,
  registerDeployAdapterResolver,
  registerMigrationStateFetcher,
  setProviderReadbacks,
  verifyRefs,
  type DeployStatusFetcher,
  type MigrationStateFetcher,
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
    const kinds: ExternalRef['kind'][] = [
      'github-pr',
      'github-comment',
      'git-remote-push',
      'deploy',
      'rollback-target',
      'migration-version',
    ];
    for (const k of kinds) {
      const rb = readbackForRef(ref({ kind: k }));
      assert.ok(rb, `no readback for kind=${k}`);
    }
  });

  it('first-match-wins on duplicate handlers', () => {
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
