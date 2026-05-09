// GET /api/cron/cleanup-expired-sso-state — Phase 5.8.
//
// Vercel cron endpoint. Vercel sends an Authorization: Bearer <CRON_SECRET>
// header on scheduled cron invocations; the route validates the header
// and refuses any other caller. Same pattern as Phase 5.7's spec
// (no public access to lifecycle cleanup).
//
// Schedule: nightly at 03:00 UTC (configured in vercel.json).
// Calls cleanup_expired_sso_states RPC with default args (24h state
// age, 30d event age).

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron-cleanup] CRON_SECRET not configured');
    return NextResponse.json({ error: 'cron_secret_missing' }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc('cleanup_expired_sso_states', {
    p_state_age_hours: 24,
    p_event_age_days: 30,
  });
  if (error) {
    console.error('[cron-cleanup] RPC failed', error);
    return NextResponse.json({ error: 'cleanup_failed', detail: error.message }, { status: 500 });
  }
  return NextResponse.json(
    { ok: true, ...(data as Record<string, unknown>) },
    { status: 200 },
  );
}
