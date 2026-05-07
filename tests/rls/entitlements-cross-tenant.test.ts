// tests/rls/entitlements-cross-tenant.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, serviceClient, type TestUser,
} from './_helpers.ts';

describe('entitlements RLS', () => {
  let alice: TestUser, bob: TestUser, charlie: TestUser;
  let aliceOrg: string, bobOrg: string;

  before(async () => {
    alice = await createTestUser('alice-ent');
    bob = await createTestUser('bob-ent');
    charlie = await createTestUser('charlie-ent');  // member of alice's org but role=member
    aliceOrg = await createOrgWithMembers('ent-alice', [
      { user: alice, role: 'owner' },
      { user: charlie, role: 'member' },
    ]);
    bobOrg = await createOrgWithMembers('ent-bob', [{ user: bob, role: 'owner' }]);

    await serviceClient.from('entitlements').insert([
      {
        organization_id: aliceOrg,
        plan: 'small',
        status: 'active',
        limits: { runs_per_month: 1000, storage_gb: 50 },
      },
      {
        organization_id: bobOrg,
        plan: 'mid',
        status: 'active',
        limits: { runs_per_month: 10000, storage_gb: 500 },
      },
    ]);
  });

  it('Owner can read their org entitlement', async () => {
    const { data, error } = await alice.client.from('entitlements')
      .select('plan, limits').eq('organization_id', aliceOrg);
    assert.equal(error, null);
    assert.equal(data?.length, 1);
    const first = data?.[0];
    assert.ok(first, 'entitlement row should exist');
    assert.equal(first.plan, 'small');
  });

  it('Member (non-admin) CANNOT read entitlement (billing-sensitive)', async () => {
    const { data } = await charlie.client.from('entitlements')
      .select('plan').eq('organization_id', aliceOrg);
    assert.equal(data?.length, 0);
  });

  it('Cross-org owner CANNOT read other org entitlement', async () => {
    const { data } = await alice.client.from('entitlements')
      .select('plan').eq('organization_id', bobOrg);
    assert.equal(data?.length, 0);
  });

  it('plan CHECK constraint rejects unknown values', async () => {
    const { error } = await serviceClient.from('entitlements').insert({
      organization_id: aliceOrg,
      plan: 'gigabrain',  // not in (free, small, mid, enterprise)
      status: 'active',
    });
    assert.notEqual(error, null, 'CHECK should reject unknown plan');
  });

  it('Authenticated user CANNOT write entitlements directly (Stripe webhook only)', async () => {
    const { error } = await alice.client.from('entitlements').update({ plan: 'enterprise' })
      .eq('organization_id', aliceOrg);
    assert.notEqual(error, null, 'client should not be able to upgrade their own plan');
  });

  after(async () => {
    await serviceClient.from('entitlements').delete().in('organization_id', [aliceOrg, bobOrg]);
    await serviceClient.from('memberships').delete().in('organization_id', [aliceOrg, bobOrg]);
    await serviceClient.from('organizations').delete().in('id', [aliceOrg, bobOrg]);
  });
});
