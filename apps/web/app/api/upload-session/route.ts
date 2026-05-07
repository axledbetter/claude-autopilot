import { NextResponse } from 'next/server';
import { randomUUID, createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveCaller } from '@/lib/upload/auth';
import { mintUploadToken } from '@/lib/upload/jwt';
import { zeroHash } from '@/lib/upload/chain';

interface Body { runId: string; expectedChunkCount: number }

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ error: 'invalid json' }, { status: 422 }); }
  if (!body?.runId || typeof body.expectedChunkCount !== 'number') {
    return NextResponse.json({ error: 'runId + expectedChunkCount required' }, { status: 422 });
  }

  const supabase = createServiceRoleClient();
  const caller = await resolveCaller(req, supabase);
  if (!caller) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: run } = await supabase.from('runs').select('id, user_id, organization_id').eq('id', body.runId).maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  const r = run as { id: string; user_id: string; organization_id: string | null };

  // Ownership: free-tier owns directly; org-tier requires active membership.
  let allowed = r.user_id === caller.userId;
  if (!allowed && r.organization_id) {
    const { data: membership } = await supabase.from('memberships')
      .select('user_id, status')
      .eq('organization_id', r.organization_id)
      .eq('user_id', caller.userId)
      .eq('status', 'active')
      .maybeSingle();
    allowed = membership !== null && membership !== undefined;
  }
  if (!allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Cancel any expired-but-unconsumed session for this run before checking
  // app-level uniqueness — otherwise stale sessions block forever (codex
  // final WARNING).
  await supabase.from('upload_sessions')
    .update({ consumed_at: new Date().toISOString() })
    .eq('run_id', body.runId)
    .is('consumed_at', null)
    .lt('expires_at', new Date().toISOString());

  // Best-effort app-level pre-check (DB partial unique index is the real guard).
  const { data: existing } = await supabase.from('upload_sessions')
    .select('id').eq('run_id', body.runId).is('consumed_at', null).maybeSingle();
  if (existing) return NextResponse.json({ error: 'in-flight session exists' }, { status: 409 });

  const sessionId = randomUUID();
  const jti = randomUUID();
  const { token, expiresAt } = mintUploadToken({
    userId: r.user_id, runId: r.id, orgId: r.organization_id, jti,
  });
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { error } = await supabase.from('upload_sessions').insert({
    id: sessionId,
    run_id: body.runId,
    user_id: r.user_id,
    organization_id: r.organization_id,
    jti,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    consumed_at: null,
    next_expected_seq: 0,
    chain_tip_hash: zeroHash,
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: 'concurrent in-flight session' }, { status: 409 });
    }
    return NextResponse.json({ error: 'db error' }, { status: 500 });
  }

  return NextResponse.json({
    uploadToken: token,
    expiresAt: expiresAt.toISOString(),
    session: { id: sessionId, runId: body.runId, jti },
  }, { status: 201 });
}
