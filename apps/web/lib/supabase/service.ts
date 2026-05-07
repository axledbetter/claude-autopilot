import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function createServiceRoleClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL missing');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-app-source': 'apps/web/upload' } },
  });
  return cached;
}

// Test seam: reset cached client between tests.
export function _resetServiceClientForTests(): void {
  cached = null;
}
