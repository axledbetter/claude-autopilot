// tests/rls/storage-cross-tenant.test.ts
//
// Codex final-pass NOTE: storage object access is the OTHER cross-tenant
// vector. Even if the metadata RLS is correct, signed URLs + direct fetch
// must enforce tenant-scoped paths.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestUser, createOrgWithMembers, serviceClient, type TestUser,
} from './_helpers.ts';

describe('Supabase Storage tenant isolation', () => {
  let alice: TestUser, bob: TestUser;
  let aliceOrg: string;

  before(async () => {
    alice = await createTestUser('alice-storage');
    bob = await createTestUser('bob-storage');
    aliceOrg = await createOrgWithMembers('storage-org', [{ user: alice, role: 'owner' }]);

    // Service role uploads a file under alice's org's path prefix.
    await serviceClient.storage.from('org-runs')
      .upload(`org/${aliceOrg}/runs/test/events.ndjson`, Buffer.from('event1\nevent2'));
    // And one under alice's free-tier path.
    await serviceClient.storage.from('user-runs')
      .upload(`user/${alice.id}/runs/test/events.ndjson`, Buffer.from('free1'));
  });

  it('Alice can read her org file', async () => {
    const { data, error } = await alice.client.storage.from('org-runs')
      .download(`org/${aliceOrg}/runs/test/events.ndjson`);
    assert.equal(error, null);
    assert.ok(data);
  });

  it('Alice can read her own free-tier file', async () => {
    const { data, error } = await alice.client.storage.from('user-runs')
      .download(`user/${alice.id}/runs/test/events.ndjson`);
    assert.equal(error, null);
    assert.ok(data);
  });

  it('Bob CANNOT read Alice\'s org file', async () => {
    const { error } = await bob.client.storage.from('org-runs')
      .download(`org/${aliceOrg}/runs/test/events.ndjson`);
    assert.notEqual(error, null, 'cross-org direct download leaked');
  });

  it('Bob CANNOT read Alice\'s free-tier file', async () => {
    const { error } = await bob.client.storage.from('user-runs')
      .download(`user/${alice.id}/runs/test/events.ndjson`);
    assert.notEqual(error, null, 'cross-user direct download leaked');
  });

  it('Bob CANNOT generate a signed URL for Alice\'s org file', async () => {
    const { error } = await bob.client.storage.from('org-runs')
      .createSignedUrl(`org/${aliceOrg}/runs/test/events.ndjson`, 60);
    assert.notEqual(error, null, 'cross-org signed URL leaked');
  });

  after(async () => {
    await serviceClient.storage.from('org-runs').remove([`org/${aliceOrg}/runs/test/events.ndjson`]);
    await serviceClient.storage.from('user-runs').remove([`user/${alice.id}/runs/test/events.ndjson`]);
    await serviceClient.from('memberships').delete().eq('organization_id', aliceOrg);
    await serviceClient.from('organizations').delete().eq('id', aliceOrg);
  });
});
