// tests/rls/audit-events-immutability.test.ts
//
// Verifies:
//   1. authenticated callers can call audit.append() (rows appear in audit.events)
//   2. authenticated callers CANNOT directly INSERT, UPDATE, or DELETE
//   3. The hash chain links via prev_hash → this_hash
//
// The migration provides a public.audit_append() wrapper that delegates to
// audit.append() — supabase-js .rpc() resolves names against the default
// (public) schema, so callers use the wrapper. Documented in 0006_audit_events.sql.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, serviceClient, type TestUser,
} from './_helpers.ts';

describe('audit.events immutability', () => {
  let alice: TestUser;
  let aliceOrg: string;

  before(async () => {
    alice = await createTestUser('alice-audit');
    aliceOrg = await createOrgWithMembers('audit-org', [{ user: alice, role: 'owner' }]);
  });

  it('authenticated user can call audit.append()', async () => {
    const { data, error } = await alice.client.rpc('audit_append', {
      p_organization_id: aliceOrg,
      p_actor_user_id: alice.id,
      p_action: 'test.event',
      p_subject_type: 'run',
      p_subject_id: 'test-run-1',
      p_metadata: {},
      p_source_verified: true,
    });
    assert.equal(error, null);
    assert.ok(typeof data === 'number' && data > 0);
  });

  it('authenticated user CANNOT INSERT directly into audit.events', async () => {
    const { error } = await alice.client.schema('audit' as any).from('events').insert({
      organization_id: aliceOrg,
      actor_user_id: alice.id,
      action: 'evil.direct-insert',
      subject_type: 'run',
      subject_id: 'evil-run',
      metadata: {},
      source_verified: false,
      this_hash: 'forged-hash',
    });
    assert.notEqual(error, null, 'direct insert should be denied');
  });

  it('authenticated user CANNOT UPDATE audit.events', async () => {
    // Use service-role to find a row id, then try to update via alice's client.
    const { data: rows } = await serviceClient.schema('audit' as any).from('events')
      .select('id').limit(1);
    let id = rows?.[0]?.id;
    if (!id) {
      // Seed one through audit.append.
      await alice.client.rpc('audit_append', {
        p_organization_id: aliceOrg,
        p_actor_user_id: alice.id,
        p_action: 'seed',
        p_subject_type: 'run',
        p_subject_id: 'seed',
        p_metadata: {},
        p_source_verified: true,
      });
      const { data: reseeded } = await serviceClient.schema('audit' as any).from('events')
        .select('id').limit(1);
      id = reseeded?.[0]?.id ?? 1;
    }
    const { error } = await alice.client.schema('audit' as any).from('events')
      .update({ action: 'tampered' }).eq('id', id);
    assert.notEqual(error, null, 'update should be denied');
  });

  it('authenticated user CANNOT DELETE audit.events', async () => {
    const { error } = await alice.client.schema('audit' as any).from('events').delete().eq('id', 1);
    assert.notEqual(error, null, 'delete should be denied');
  });

  it('hash chain: prev_hash of entry N+1 equals this_hash of entry N (per org)', async () => {
    // Emit two appends back-to-back, verify the chain.
    await alice.client.rpc('audit_append', {
      p_organization_id: aliceOrg,
      p_actor_user_id: alice.id,
      p_action: 'chain.first',
      p_subject_type: 'run', p_subject_id: 'a',
      p_metadata: {}, p_source_verified: true,
    });
    await alice.client.rpc('audit_append', {
      p_organization_id: aliceOrg,
      p_actor_user_id: alice.id,
      p_action: 'chain.second',
      p_subject_type: 'run', p_subject_id: 'b',
      p_metadata: {}, p_source_verified: true,
    });

    const { data: rows } = await serviceClient.schema('audit' as any).from('events')
      .select('id, prev_hash, this_hash')
      .eq('organization_id', aliceOrg)
      .order('id', { ascending: true });

    const chainRows = rows ?? [];
    assert.ok(chainRows.length >= 2);
    for (let i = 1; i < chainRows.length; i++) {
      const cur = chainRows[i];
      const prev = chainRows[i - 1];
      if (!cur || !prev) continue;
      assert.equal(cur.prev_hash, prev.this_hash, `chain break at row ${i}`);
    }
  });

  after(async () => {
    await serviceClient.schema('audit' as any).from('events').delete().eq('organization_id', aliceOrg);
    await serviceClient.from('memberships').delete().eq('organization_id', aliceOrg);
    await serviceClient.from('organizations').delete().eq('id', aliceOrg);
  });
});
