import { createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';

export interface ApiKeyAuth { userId: string; keyId: string }

export class AuthHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthHelperError';
  }
}

const KEY_RE = /^clp_[0-9a-f]{64}$/;

/**
 * Centralized helper for API-key auth on dashboard endpoints.
 *
 * Looks up a key by deterministic SHA256 hash (eq + maybeSingle, O(1)),
 * filters out revoked keys, and fires a non-blocking last_used_at touch.
 *
 * Returns null when the request is unauthenticated (missing header,
 * malformed key, unknown hash, revoked). Routes turn null into 401.
 *
 * Throws AuthHelperError for unexpected DB errors so routes can return
 * 500/503 instead of misreporting an outage as 401 (codex PR WARNING).
 */
export async function authViaApiKey(req: Request): Promise<ApiKeyAuth | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer clp_')) return null;
  const raw = auth.slice('Bearer '.length).trim();
  if (!KEY_RE.test(raw)) return null;
  const hashHex = createHash('sha256').update(raw).digest('hex');

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from('api_keys')
    .select('id, user_id')
    .eq('key_hash', hashHex)
    .is('revoked_at', null)
    .maybeSingle();

  // Distinguish DB outage from "not found" — maybeSingle returns
  // { data: null, error: null } on no rows, and { data: null, error: ... }
  // on actual DB problems.
  if (error) {
    throw new AuthHelperError(`api-key auth lookup failed: ${error.message}`);
  }
  if (!data) return null;
  const row = data as { id: string; user_id: string };

  // Fire-and-forget last_used_at touch.
  void supabase.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id)
    .then(() => {}, () => {});

  return { userId: row.user_id, keyId: row.id };
}
