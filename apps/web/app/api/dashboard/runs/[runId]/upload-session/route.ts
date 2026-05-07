import { NextResponse } from 'next/server';
import { randomUUID, createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { authViaApiKey } from '@/lib/dashboard/auth';
import { mintUploadToken } from '@/lib/upload/jwt';

interface RouteParams {
  params: Promise<{ runId: string }> | { runId: string };
}

interface SessionRow {
  id: string;
  run_id: string;
  user_id: string;
  organization_id: string | null;
  jti: string;
  expires_at: string;
  consumed_at: string | null;
  next_expected_seq: number;
}

interface RunRow {
  id: string;
  user_id: string;
  organization_id: string | null;
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { runId: string };

  // API-key auth only — this endpoint is for the CLI uploader.
  const auth = await authViaApiKey(req);
  if (!auth) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const supabase = createServiceRoleClient();

  // Resolve run + ownership.
  const { data: run } = await supabase.from('runs')
    .select('id, user_id, organization_id')
    .eq('id', p.runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = run as RunRow;

  let allowed = r.user_id === auth.userId;
  if (!allowed && r.organization_id) {
    const { data: membership } = await supabase.from('memberships')
      .select('user_id, status')
      .eq('organization_id', r.organization_id)
      .eq('user_id', auth.userId)
      .eq('status', 'active')
      .maybeSingle();
    allowed = membership !== null && membership !== undefined;
  }
  // Codex pass 2 CRITICAL #3 — ownership-scoped 404 (don't leak existence
  // of runs the caller can't see).
  if (!allowed) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Look up in-flight session for this run.
  const { data: existing } = await supabase.from('upload_sessions')
    .select('id, run_id, user_id, organization_id, jti, expires_at, consumed_at, next_expected_seq')
    .eq('run_id', p.runId)
    .is('consumed_at', null)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const s = existing as SessionRow;

  // If still valid, re-mint fresh JWT bound to the SAME jti so the same
  // upload_sessions row can keep accepting chunks. Update token_hash +
  // expires_at on the row.
  const expired = new Date(s.expires_at) < new Date();
  if (!expired) {
    const { token, expiresAt } = mintUploadToken({
      userId: s.user_id, runId: s.run_id, orgId: s.organization_id, jti: s.jti,
    });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await supabase.from('upload_sessions')
      .update({ token_hash: tokenHash, expires_at: expiresAt.toISOString() })
      .eq('id', s.id);
    return NextResponse.json({
      uploadToken: token,
      expiresAt: expiresAt.toISOString(),
      session: {
        id: s.id,
        runId: s.run_id,
        jti: s.jti,
        nextExpectedSeq: s.next_expected_seq,
      },
    }, { status: 200 });
  }

  // Expired but not consumed — caller should re-mint via POST /api/upload-session.
  // Mark this one consumed so the new mint isn't blocked by the in-flight uniqueness.
  await supabase.from('upload_sessions')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', s.id)
    .is('consumed_at', null);
  // Re-mint a fresh session row so the resume path is one-shot for the caller.
  const sessionId = randomUUID();
  const jti = randomUUID();
  const { token, expiresAt } = mintUploadToken({
    userId: s.user_id, runId: s.run_id, orgId: s.organization_id, jti,
  });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const zeroHash = '0'.repeat(64);
  const { error } = await supabase.from('upload_sessions').insert({
    id: sessionId,
    run_id: s.run_id,
    user_id: s.user_id,
    organization_id: s.organization_id,
    jti,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    consumed_at: null,
    next_expected_seq: 0,
    chain_tip_hash: zeroHash,
  });
  if (error) {
    return NextResponse.json({ error: 'failed to remint session' }, { status: 500 });
  }
  return NextResponse.json({
    uploadToken: token,
    expiresAt: expiresAt.toISOString(),
    session: {
      id: sessionId,
      runId: s.run_id,
      jti,
      nextExpectedSeq: 0,
    },
  }, { status: 200 });
}
