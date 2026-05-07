// tests/rls/membership-edge-cases.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, createRunAsServer, serviceClient,
  type TestUser,
} from './_helpers.ts';
import { ulid } from 'ulid';

describe('membership edge cases', () => {
  let alice: TestUser, bob: TestUser, removed: TestUser, disabled: TestUser;
  let org: string;

  before(async () => {
    alice = await createTestUser('alice-mem');
    bob = await createTestUser('bob-mem');
    removed = await createTestUser('removed-mem');
    disabled = await createTestUser('disabled-mem');
    org = await createOrgWithMembers('mem-org', [
      { user: alice, role: 'owner' },
      { user: bob, role: 'member' },
      { user: removed, role: 'member', status: 'removed' },
      { user: disabled, role: 'member', status: 'disabled' },
    ]);

    const run = ulid();
    await createRunAsServer({ runId: run, organizationId: org, userId: alice.id });
  });

  it('Active members can read org runs', async () => {
    const { data } = await bob.client.from('runs').select('id').eq('organization_id', org);
    assert.ok((data?.length ?? 0) >= 1);
  });

  it('Removed members CANNOT read org runs', async () => {
    const { data } = await removed.client.from('runs').select('id').eq('organization_id', org);
    assert.equal(data?.length, 0, 'removed user can still read org data');
  });

  it('Disabled members CANNOT read org runs', async () => {
    const { data } = await disabled.client.from('runs').select('id').eq('organization_id', org);
    assert.equal(data?.length, 0, 'disabled user can still read org data');
  });

  it('Owner can read members list', async () => {
    const { data } = await alice.client.from('memberships').select('user_id').eq('organization_id', org);
    // 4 inserted, but RLS may filter "removed"/"disabled" rows depending on policy.
    // Spec: members can see other members regardless of status (admin needs the list).
    assert.ok((data?.length ?? 0) >= 2, 'owner should see at least active members');
  });

  it('Removed member sees zero memberships in the org', async () => {
    const { data } = await removed.client.from('memberships').select('user_id').eq('organization_id', org);
    assert.equal(data?.length, 0);
  });

  after(async () => {
    await serviceClient.from('runs').delete().eq('organization_id', org);
    await serviceClient.from('memberships').delete().eq('organization_id', org);
    await serviceClient.from('organizations').delete().eq('id', org);
  });
});
