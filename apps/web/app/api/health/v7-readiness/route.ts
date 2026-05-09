// GET /api/health/v7-readiness — v7.1.3.
//
// Operator deploy-verification endpoint. Hit this AFTER deploying a v7.0+
// web image to confirm:
//   - the Phase 6 `check_membership_status` RPC is present + executable;
//   - all required env vars are set + meet length minimums.
//
// Closes codex PR #141 PR-pass WARNING #3 ("RPC dependency health check")
// and gives the runbook's first-deploy checklist a deterministic gate
// instead of "smoke-test /dashboard manually."
//
// Auth: `Authorization: Bearer ${CRON_SECRET}` — same pattern as the
// existing /api/cron/cleanup-expired-sso-state route. Same secret because
// it's the only operator-only secret we already require to be set; we
// don't add a NEW dedicated one for this surface. Comparison is
// constant-time via crypto.timingSafeEqual.
//
// Response shape (200 if all required pass; 503 if any required fail):
//   {
//     ok: boolean,                     // false if any required check failed
//     totalChecks: number,
//     passed: number,
//     failed: number,
//     checks: [
//       { name: string, status: 'pass' | 'fail' | 'skipped', message?: string }
//     ]
//   }
//
// `message` is included on fail/skipped entries to tell the operator what
// to fix. It does NOT include secret values — only "missing" or "too
// short (got N bytes)" type strings. Authentication is required, so even
// if a check name leaked it would be from an authorized caller.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  required: boolean;
  message?: string;
}

const MIN_SECRET_BYTES = 32;
// Sentinel UUIDs used to probe the RPC. Both nil — RPC returns synthetic
// `{status: 'no_row'}` (Phase 6 contract). Any other response shape is
// a real RPC failure.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function envCheck(name: string, options: { minBytes?: number; required?: boolean } = {}): CheckResult {
  const required = options.required ?? true;
  const minBytes = options.minBytes ?? 0;
  const raw = process.env[name];
  if (!raw || typeof raw !== 'string') {
    return { name, status: required ? 'fail' : 'skipped', required, message: 'env var not set' };
  }
  if (minBytes > 0) {
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes < minBytes) {
      return {
        name,
        status: 'fail',
        required,
        message: `too short (got ${bytes} bytes; need ≥${minBytes})`,
      };
    }
  }
  return { name, status: 'pass', required };
}

async function rpcCheck(): Promise<CheckResult> {
  const name = 'check_membership_status_rpc';
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase.rpc('check_membership_status', {
      p_org_id: NIL_UUID,
      p_user_id: NIL_UUID,
    });
    if (error) {
      return { name, status: 'fail', required: true, message: `RPC error: ${error.message}` };
    }
    if (!data || typeof data !== 'object' || !('status' in (data as object))) {
      return { name, status: 'fail', required: true, message: 'RPC returned unexpected shape' };
    }
    // 'no_row' is the expected synthetic response for nil UUIDs (Phase 6
    // RPC contract). Anything else (incl. 'active') is also acceptable —
    // the contract is "always returns one row with a status field."
    return { name, status: 'pass', required: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', required: true, message: `RPC call threw: ${message}` };
  }
}

export async function GET(req: Request): Promise<Response> {
  // 1. Auth gate — CRON_SECRET via timing-safe compare.
  const auth = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron_secret_missing' }, { status: 500 });
  }
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const presented = auth.slice('Bearer '.length).trim();
  const presentedBuf = Buffer.from(presented, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (
    presentedBuf.length !== expectedBuf.length
    || !timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Run all checks.
  const checks: CheckResult[] = [];

  // Required env vars (any missing → 503).
  checks.push(envCheck('NEXT_PUBLIC_SUPABASE_URL'));
  checks.push(envCheck('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
  checks.push(envCheck('SUPABASE_SERVICE_ROLE_KEY'));
  checks.push(envCheck('AUTOPILOT_PUBLIC_BASE_URL'));
  checks.push(envCheck('UPLOAD_SESSION_JWT_SECRET', { minBytes: MIN_SECRET_BYTES }));
  checks.push(envCheck('SSO_STATE_SIGNING_SECRET', { minBytes: MIN_SECRET_BYTES }));
  checks.push(envCheck('MEMBERSHIP_CHECK_COOKIE_SECRET', { minBytes: MIN_SECRET_BYTES }));
  checks.push(envCheck('STRIPE_SECRET_KEY'));
  checks.push(envCheck('STRIPE_WEBHOOK_SECRET'));
  checks.push(envCheck('WORKOS_API_KEY'));
  checks.push(envCheck('WORKOS_CLIENT_ID'));
  checks.push(envCheck('WORKOS_WEBHOOK_SECRET'));

  // Required RPC (Phase 6 dependency).
  checks.push(await rpcCheck());

  const failed = checks.filter((c) => c.required && c.status === 'fail').length;
  const passed = checks.filter((c) => c.status === 'pass').length;
  const ok = failed === 0;

  return NextResponse.json(
    { ok, totalChecks: checks.length, passed, failed, checks },
    { status: ok ? 200 : 503 },
  );
}
