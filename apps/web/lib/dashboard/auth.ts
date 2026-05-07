import { createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';

export interface ApiKeyAuth { userId: string; keyId: string }

const KEY_RE = /^clp_[0-9a-f]{64}$/;

/**
 * Centralized helper for API-key auth on dashboard endpoints.
 *
 * Looks up a key by deterministic SHA256 hash (eq + maybeSingle, O(1)),
 * filters out revoked keys, and fires a non-blocking last_used_at touch.
 *
 * Returns null on any failure (missing header, malformed key, unknown
 * hash, revoked). Routes turn null into 401.
 */
export async function authViaApiKey(req: Request): Promise<ApiKeyAuth | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer clp_')) return null;
  const raw = auth.slice('Bearer '.length).trim();
  if (!KEY_RE.test(raw)) return null;
  const hashHex = createHash('sha256').update(raw).digest('hex');

  const supabase = createServiceRoleClient();
  const { data } = await supabase.from('api_keys')
    .select('id, user_id')
    .eq('key_hash', hashHex)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; user_id: string };

  // Fire-and-forget last_used_at touch.
  void supabase.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(() => {}, () => {});

  return { userId: row.user_id, keyId: row.id };
}
