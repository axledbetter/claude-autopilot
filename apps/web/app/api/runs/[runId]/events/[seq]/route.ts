import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { verifyUploadToken, TokenError } from '@/lib/upload/jwt';
import { hashChunk } from '@/lib/upload/chain';
import { chunkPath, putObject, StorageWriteError } from '@/lib/upload/storage';
import { existingBytesEqual } from '@/lib/upload/storage-verify';

const MAX_CHUNK_BYTES = 1024 * 1024;

// Map RPC error codes (set in claim_chunk_slot via RAISE EXCEPTION ... USING ERRCODE)
// to HTTP status + error payload.
const RPC_ERROR_HTTP: Record<string, { status: number; error: string }> = {
  P0001: { status: 401, error: 'session not found' },
  P0002: { status: 401, error: 'session consumed' },
  P0003: { status: 401, error: 'session expired' },
  P0004: { status: 403, error: 'ownership mismatch' },
  P0005: { status: 409, error: 'duplicate chunk content mismatch' },
  P0006: { status: 422, error: 'wrong seq' },
  P0007: { status: 409, error: 'prev hash mismatch' },
};

interface RouteParams {
  params: Promise<{ runId: string; seq: string }> | { runId: string; seq: string };
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  // Next.js 16 may pass params as a Promise (codex final WARNING).
  const p = await Promise.resolve(params) as { runId: string; seq: string };

  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let claims;
  try { claims = verifyUploadToken(auth.slice('Bearer '.length)); }
  catch (err) {
    if (err instanceof TokenError && err.reason === 'expired') {
      return NextResponse.json({ error: 'token expired' }, { status: 401 });
    }
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  if (claims.run_id !== p.runId) {
    return NextResponse.json({ error: 'run mismatch' }, { status: 403 });
  }

  const seq = Number.parseInt(p.seq, 10);
  if (!Number.isInteger(seq) || seq < 0) {
    return NextResponse.json({ error: 'invalid seq' }, { status: 422 });
  }

  const prevHashHeader = req.headers.get('x-chunk-prev-hash');
  if (!prevHashHeader || !/^[0-9a-f]{64}$/.test(prevHashHeader)) {
    return NextResponse.json({ error: 'missing or malformed x-chunk-prev-hash' }, { status: 422 });
  }

  const bodyBuf = Buffer.from(await req.arrayBuffer());
  if (bodyBuf.length > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: 'chunk too large' }, { status: 413 });
  }

  const supabase = createServiceRoleClient();
  const thisHash = hashChunk(prevHashHeader, bodyBuf);

  // Resolve scope from session row for the storage path. Must read session
  // to know org_id; this read does NOT advance state — claim_chunk_slot
  // is the atomic op.
  const { data: sessionRow } = await supabase.from('upload_sessions')
    .select('id, user_id, organization_id, expires_at')
    .eq('jti', claims.jti).maybeSingle();
  if (!sessionRow) return NextResponse.json({ error: 'session not found' }, { status: 401 });
  const s = sessionRow as { id: string; user_id: string; organization_id: string | null; expires_at: string };

  // Pre-check session expiry so we can give a clear 401 distinct from
  // token-expired (the JWT may still be within its 15-min TTL even if
  // the session DB row has been marked expired).
  if (new Date(s.expires_at) < new Date()) {
    return NextResponse.json({ error: 'session expired' }, { status: 401 });
  }

  const path = chunkPath({ organizationId: s.organization_id, userId: s.user_id }, p.runId, seq);

  // Phase 1: claim the slot atomically. RPC handles row lock + duplicate
  // recovery + seq/prev_hash validation.
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_chunk_slot', {
    p_jti: claims.jti,
    p_run_id: p.runId,
    p_caller_user_id: claims.sub,
    p_seq: seq,
    p_prev_hash: prevHashHeader,
    p_this_hash: thisHash,
    p_bytes: bodyBuf.length,
    p_storage_path: path,
  });
  if (claimErr) {
    const code = (claimErr as { code?: string }).code;
    const mapped = code ? RPC_ERROR_HTTP[code] : undefined;
    if (mapped) return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    return NextResponse.json({ error: 'rpc error' }, { status: 500 });
  }
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    return NextResponse.json({ error: 'rpc returned no rows' }, { status: 500 });
  }

  // Phase 2: Storage write. If duplicate, verify byte-equality before
  // treating as idempotent (codex final CRITICAL — silent advance forbidden).
  try {
    await putObject(path, bodyBuf, 'application/x-ndjson');
  } catch (err) {
    if (err instanceof StorageWriteError && err.kind === 'duplicate') {
      const ok = await existingBytesEqual(path, bodyBuf);
      if (!ok) {
        // The pending DB row says "this hash, this byte count", but the
        // existing object differs. Refuse to advance.
        return NextResponse.json({ error: 'storage object content mismatch on retry' }, { status: 409 });
      }
      // Identical bytes — idempotent retry of crashed handler. Fall through
      // to mark_chunk_persisted.
    } else {
      // Storage failure (not duplicate). Pending DB row is reclaimable on
      // retry by the same payload — leave it; do NOT delete.
      return NextResponse.json({ error: 'storage error' }, { status: 500 });
    }
  }

  // Phase 3: mark persisted + advance session. RPC is idempotent.
  const { error: persistErr } = await supabase.rpc('mark_chunk_persisted', {
    p_session_id: s.id,
    p_seq: seq,
    p_this_hash: thisHash,
  });
  if (persistErr) return NextResponse.json({ error: 'persist rpc error' }, { status: 500 });

  return NextResponse.json({ seq, hash: thisHash, bytes: bodyBuf.length }, { status: 201 });
}
