// tests/rls/upload-sessions.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestUser, serviceClient, type TestUser } from './_helpers.ts';
import { randomUUID, createHash } from 'node:crypto';

describe('upload_sessions storage', () => {
  let alice: TestUser, bob: TestUser;

  before(async () => {
    alice = await createTestUser('alice-up');
    bob = await createTestUser('bob-up');
  });

  it('Authenticated user CANNOT INSERT directly', async () => {
    const { error } = await alice.client.from('upload_sessions').insert({
      user_id: alice.id,
      run_id: 'r1',
      jti: randomUUID(),
      token_hash: 'x',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.notEqual(error, null, 'client should not mint upload sessions');
  });

  it('Service-role inserted session is readable by owner only', async () => {
    const jti = randomUUID();
    const tokenHash = createHash('sha256').update('fake-token-bytes').digest('hex');
    const { data, error } = await serviceClient.from('upload_sessions').insert({
      user_id: alice.id,
      run_id: 'r2',
      jti,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }).select('id').single();
    assert.equal(error, null);
    const sessionId = data!.id;

    // Owner can read.
    const { data: aliceRead } = await alice.client.from('upload_sessions')
      .select('id, jti').eq('id', sessionId);
    assert.equal(aliceRead?.length, 1);

    // Bob cannot read.
    const { data: bobRead } = await bob.client.from('upload_sessions')
      .select('id').eq('id', sessionId);
    assert.equal(bobRead?.length, 0);
  });

  it('Authenticated user CANNOT UPDATE consumed_at (single-use enforcement)', async () => {
    // Postgres RLS USING(false) on UPDATE silently filters all rows → 0
    // rows affected, no error returned. Defense is correct; we verify by
    // reading back and confirming consumed_at stayed null. Same shape as
    // entitlements no-client-write.
    const { data: row } = await serviceClient.from('upload_sessions')
      .select('id').eq('user_id', alice.id).limit(1).single();
    if (!row) throw new Error('test setup: no upload_session row to update');
    await alice.client.from('upload_sessions')
      .update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
    const { data: after } = await serviceClient.from('upload_sessions')
      .select('consumed_at').eq('id', row.id).single();
    assert.equal(after?.consumed_at, null, 'client must not be able to mark session consumed');
  });

  it('expired_at < consumed_at is rejected by CHECK constraint', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const farFuture = new Date(Date.now() + 7_200_000);
    const { error } = await serviceClient.from('upload_sessions').insert({
      user_id: alice.id,
      run_id: 'r3',
      jti: randomUUID(),
      token_hash: 'x',
      expires_at: future.toISOString(),
      consumed_at: farFuture.toISOString(),
    });
    assert.notEqual(error, null, 'CHECK constraint should reject consumed_at > expires_at');
  });

  after(async () => {
    await serviceClient.from('upload_sessions').delete().eq('user_id', alice.id);
  });
});
