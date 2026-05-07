// tests/rls/free-vs-org-tier.test.ts
//
// Codex final-pass WARNING: the two-branch RLS pattern can leak if the
// disjunction is mis-spelled. These tests pin both branches independently.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, createRunAsServer, serviceClient,
  type TestUser,
} from './_helpers.ts';
import { ulid } from 'ulid';

describe('runs RLS — two-branch pattern coverage', () => {
  let alice: TestUser, bob: TestUser;
  let aliceOrg: string;
  let aliceOrgRun: string, aliceFreeRun: string, bobOrgRun: string, bobFreeRun: string;

  before(async () => {
    alice = await createTestUser('alice2');
    bob = await createTestUser('bob2');
    aliceOrg = await createOrgWithMembers('alice-org-2', [{ user: alice, role: 'owner' }]);

    aliceOrgRun = ulid();
    aliceFreeRun = ulid();
    bobOrgRun = ulid();   // bob has no org, so this row would never be created in prod;
                          // we use an org that bob is NOT a member of (alice's) to test
                          // the org-tier deny path.
    bobFreeRun = ulid();

    await createRunAsServer({ runId: aliceOrgRun, organizationId: aliceOrg, userId: alice.id });
    await createRunAsServer({ runId: aliceFreeRun, organizationId: null, userId: alice.id });
    // Synthetic: bob's row tagged with alice's org (cross-tenant test fixture).
    await createRunAsServer({ runId: bobOrgRun, organizationId: aliceOrg, userId: bob.id });
    await createRunAsServer({ runId: bobFreeRun, organizationId: null, userId: bob.id });
  });

  it('org-tier branch: member can read row in their org regardless of user_id', async () => {
    // bobOrgRun is in alice's org; alice is a member; alice should see it.
    const { data } = await alice.client.from('runs').select('id').eq('id', bobOrgRun);
    assert.equal(data?.length, 1);
  });

  it('free-tier branch: row owner can read regardless of org membership', async () => {
    // aliceFreeRun has org_id NULL; alice owns it; she should see it.
    const { data } = await alice.client.from('runs').select('id').eq('id', aliceFreeRun);
    assert.equal(data?.length, 1);
  });

  it('free-tier branch: non-owner CANNOT read another user\'s free run', async () => {
    // bobFreeRun has org_id NULL; alice does NOT own it.
    const { data } = await alice.client.from('runs').select('id').eq('id', bobFreeRun);
    assert.equal(data?.length, 0);
  });

  it('org-tier branch: non-member CANNOT read org row even if they own it', async () => {
    // bobOrgRun is in alice's org but bob owns it; bob is NOT a member.
    // The free-tier branch (org_id IS NULL) does not apply (org_id is set).
    // Bob must rely on org-tier branch — which fails. Result: 0 rows.
    const { data } = await bob.client.from('runs').select('id').eq('id', bobOrgRun);
    assert.equal(data?.length, 0, 'free-tier branch leaked into org-tier row');
  });

  it('public visibility bypasses both branches', async () => {
    const publicRun = ulid();
    await createRunAsServer({
      runId: publicRun, organizationId: aliceOrg, userId: alice.id, visibility: 'public',
    });
    // bob is not a member, doesn't own — but visibility=public should let him read.
    const { data } = await bob.client.from('runs').select('id').eq('id', publicRun);
    assert.equal(data?.length, 1);
    await serviceClient.from('runs').delete().eq('id', publicRun);
  });

  after(async () => {
    await serviceClient.from('runs').delete().in('id', [aliceOrgRun, aliceFreeRun, bobOrgRun, bobFreeRun]);
    await serviceClient.from('memberships').delete().eq('organization_id', aliceOrg);
    await serviceClient.from('organizations').delete().eq('id', aliceOrg);
  });
});
