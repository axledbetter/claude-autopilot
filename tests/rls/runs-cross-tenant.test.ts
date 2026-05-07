// tests/rls/runs-cross-tenant.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, createRunAsServer, serviceClient,
  type TestUser,
} from './_helpers.ts';
import { ulid } from 'ulid';  // dev-add this dep if not present, or use crypto-random

describe('runs cross-tenant RLS', () => {
  let alice: TestUser, bob: TestUser, eve: TestUser;
  let aliceOrg: string, bobOrg: string;
  let aliceOrgRun: string, aliceFreeRun: string, bobOrgRun: string;

  before(async () => {
    alice = await createTestUser('alice');
    bob = await createTestUser('bob');
    eve = await createTestUser('eve');  // member of NO org
    aliceOrg = await createOrgWithMembers('alice-org', [{ user: alice, role: 'owner' }]);
    bobOrg = await createOrgWithMembers('bob-org', [{ user: bob, role: 'owner' }]);

    aliceOrgRun = ulid();
    aliceFreeRun = ulid();
    bobOrgRun = ulid();

    await createRunAsServer({ runId: aliceOrgRun, organizationId: aliceOrg, userId: alice.id });
    await createRunAsServer({ runId: aliceFreeRun, organizationId: null, userId: alice.id });
    await createRunAsServer({ runId: bobOrgRun, organizationId: bobOrg, userId: bob.id });
  });

  it('Alice can read her org run', async () => {
    const { data, error } = await alice.client.from('runs').select('id').eq('id', aliceOrgRun);
    assert.equal(error, null);
    assert.equal(data?.length, 1);
  });

  it('Alice can read her free-tier run (org_id IS NULL)', async () => {
    const { data, error } = await alice.client.from('runs').select('id').eq('id', aliceFreeRun);
    assert.equal(error, null);
    assert.equal(data?.length, 1);
  });

  it('Alice CANNOT read Bob org run', async () => {
    const { data, error } = await alice.client.from('runs').select('id').eq('id', bobOrgRun);
    assert.equal(error, null);
    assert.equal(data?.length, 0, 'cross-tenant read leaked');
  });

  it('Eve (no org) CANNOT read any run', async () => {
    const { data: aliceData } = await eve.client.from('runs').select('id').eq('id', aliceOrgRun);
    const { data: bobData } = await eve.client.from('runs').select('id').eq('id', bobOrgRun);
    assert.equal(aliceData?.length, 0);
    assert.equal(bobData?.length, 0);
  });

  it('Eve CANNOT read Alice free-tier run', async () => {
    const { data } = await eve.client.from('runs').select('id').eq('id', aliceFreeRun);
    assert.equal(data?.length, 0);
  });

  after(async () => {
    // Cleanup is handled by `db:reset` in CI; locally devs must reset.
    await serviceClient.from('memberships').delete().in('organization_id', [aliceOrg, bobOrg]);
    await serviceClient.from('runs').delete().in('id', [aliceOrgRun, aliceFreeRun, bobOrgRun]);
    await serviceClient.from('organizations').delete().in('id', [aliceOrg, bobOrg]);
  });
});
