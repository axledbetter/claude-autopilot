import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stub } from '../../_helpers/supabase-stub';
import { createHash } from 'crypto';

vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: () => stub.asClient(),
  _resetServiceClientForTests: () => stub.reset(),
}));

const { authViaApiKey } = await import('@/lib/dashboard/auth');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function seedKey(userId: string, raw: string): void {
  const keyHash = createHash('sha256').update(raw).digest('hex');
  stub.seed('api_keys', [{
    id: 'key1',
    user_id: userId,
    key_hash: keyHash,
    prefix_display: `clp_${raw.slice(4, 16)}`,
    label: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
  }]);
}

const VALID_KEY = `clp_${'a'.repeat(64)}`;

describe('authViaApiKey', () => {
  it('returns auth for valid bearer', async () => {
    seedKey('user1', VALID_KEY);
    const req = new Request('http://x', { headers: { authorization: `Bearer ${VALID_KEY}` } });
    const result = await authViaApiKey(req);
    expect(result).toEqual({ userId: 'user1', keyId: 'key1' });
  });

  it('returns null for missing auth header', async () => {
    const req = new Request('http://x');
    expect(await authViaApiKey(req)).toBeNull();
  });

  it('returns null for malformed key shape', async () => {
    const req = new Request('http://x', { headers: { authorization: 'Bearer not-a-key' } });
    expect(await authViaApiKey(req)).toBeNull();
  });

  it('returns null for revoked key', async () => {
    seedKey('user1', VALID_KEY);
    const rows = stub.tables.get('api_keys');
    if (rows && rows[0]) {
      rows[0].revoked_at = new Date().toISOString();
    }
    const req = new Request('http://x', { headers: { authorization: `Bearer ${VALID_KEY}` } });
    expect(await authViaApiKey(req)).toBeNull();
  });

  it('returns null for unknown key', async () => {
    seedKey('user1', VALID_KEY);
    const otherKey = `clp_${'b'.repeat(64)}`;
    const req = new Request('http://x', { headers: { authorization: `Bearer ${otherKey}` } });
    expect(await authViaApiKey(req)).toBeNull();
  });
});
