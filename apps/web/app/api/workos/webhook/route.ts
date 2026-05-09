// POST /api/workos/webhook — Phase 5.4.
//
// WorkOS connection lifecycle webhook. Runtime nodejs (we need raw bytes
// for HMAC verify; edge body parsing would corrupt them).
//
// Flow:
//   1. Read raw body via req.text(). NOT req.json() — verifier needs the
//      exact bytes WorkOS signed.
//   2. verifyWorkOSSignature → returns {ok, event} | {ok:false, reason}.
//      401 webhook_signature_invalid on failure.
//   3. Hash payload (SHA-256, hex). Pass to apply_workos_event RPC which
//      handles claim/lease/complete + lifecycle ordering + state +
//      audit append in one txn.
//   4. Map RPC result → 200 OK or 5xx (re-attempt next retry).
//
// Spec §5: WorkOS retries on non-2xx for ~24h, so any unhandled
// transient error MUST 5xx — never silently 200 it.

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { verifyWorkOSSignature } from '@/lib/workos/client';

export const runtime = 'nodejs';

interface WorkOSEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
}

function extractWorkOSOrgId(data: Record<string, unknown>): string | null {
  const orgId = (data as { organization_id?: unknown }).organization_id;
  if (typeof orgId === 'string' && orgId.length > 0) return orgId;
  const org = (data as { organization?: { id?: unknown } }).organization;
  if (org && typeof org.id === 'string') return org.id;
  return null;
}

function extractWorkOSConnectionId(data: Record<string, unknown>): string | null {
  const cid = (data as { id?: unknown }).id;
  if (typeof cid === 'string' && cid.length > 0) return cid;
  const conn = (data as { connection?: { id?: unknown } }).connection;
  if (conn && typeof conn.id === 'string') return conn.id;
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const sigHeader = req.headers.get('workos-signature');

  const verify = verifyWorkOSSignature(rawBody, sigHeader);
  if (!verify.ok) {
    return NextResponse.json(
      { error: 'webhook_signature_invalid', reason: verify.reason },
      { status: 401 },
    );
  }

  const event = verify.event as WorkOSEvent;
  const workosOrgId = extractWorkOSOrgId(event.data);
  const workosConnectionId = extractWorkOSConnectionId(event.data);

  if (!workosOrgId) {
    return NextResponse.json(
      { result: 'no_organization_id', eventId: event.id, eventType: event.event },
      { status: 200 },
    );
  }

  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.rpc('apply_workos_event', {
    p_event_id: event.id,
    p_event_type: event.event,
    p_workos_organization_id: workosOrgId,
    p_workos_connection_id: workosConnectionId,
    p_event_occurred_at: event.createdAt,
    p_payload_hash: payloadHash,
    p_lock_seconds: 60,
  });
  if (error) {
    return NextResponse.json(
      { error: 'apply_failed', detail: error.message ?? 'unknown' },
      { status: 500 },
    );
  }

  return NextResponse.json(data, { status: 200 });
}
