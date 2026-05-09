#!/usr/bin/env tsx
// Phase 5.7 — ops/cron-callable wrapper around cleanup_expired_sso_states RPC.
//
// Codex pass-1 CRITICAL #3 — no HTTP route. Service-role-only. Phase 6
// will wire this script into a Vercel cron schedule.
//
// Override defaults via env: STATE_AGE_HOURS (default 24), EVENT_AGE_DAYS (default 30).

import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const stateAgeHours = Number(process.env.STATE_AGE_HOURS ?? 24);
  const eventAgeDays = Number(process.env.EVENT_AGE_DAYS ?? 30);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL missing');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc('cleanup_expired_sso_states', {
    p_state_age_hours: stateAgeHours,
    p_event_age_days: eventAgeDays,
  });
  if (error) {
    console.error('[cleanup] RPC failed', error);
    process.exit(1);
  }
  console.log('[cleanup] success', data);
}

main().catch((err) => {
  console.error('[cleanup] unexpected error', err);
  process.exit(1);
});
