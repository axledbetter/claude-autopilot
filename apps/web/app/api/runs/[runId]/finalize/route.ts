import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { verifyUploadToken, TokenError, type UploadTokenClaims } from '@/lib/upload/jwt';
import { sha256OfCanonical, canonicalJsonBytes } from '@/lib/upload/canonical';
import { manifestPath, statePath, putObject, StorageWriteError } from '@/lib/upload/storage';
import { existingBytesEqual } from '@/lib/upload/storage-verify';
import { withSessionTransaction } from '@/lib/upload/transaction';

interface Body { chainRoot: string; expectedChunkCount: number; stateJson: unknown }

interface RouteParams {
  params: Promise<{ runId: string }> | { runId: string };
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const p = await Promise.resolve(params) as { runId: string };

  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let claims: UploadTokenClaims;
  try { claims = verifyUploadToken(auth.slice('Bearer '.length)); }
  catch (err) {
    if (err instanceof TokenError && err.reason === 'expired') {
      return NextResponse.json({ error: 'token expired' }, { status: 401 });
    }
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  if (claims.run_id !== p.runId) return NextResponse.json({ error: 'run mismatch' }, { status: 403 });

  let body: Body;
  try { body = await req.json() as Body; } catch { return NextResponse.json({ error: 'invalid json' }, { status: 422 }); }
  if (!body || typeof body.chainRoot !== 'string' || !Number.isInteger(body.expectedChunkCount) || body.stateJson === undefined) {
    return NextResponse.json({ error: 'malformed body' }, { status: 422 });
  }

  return withSessionTransaction(claims.jti, async () => {
    const supabase = createServiceRoleClient();
    const { data: sessionRow } = await supabase.from('upload_sessions')
      .select('id, run_id, user_id, organization_id, next_expected_seq, chain_tip_hash, consumed_at, expires_at')
      .eq('jti', claims.jti).maybeSingle();
    if (!sessionRow) return NextResponse.json({ error: 'session not found' }, { status: 401 });
    const s = sessionRow as {
      id: string; run_id: string; user_id: string; organization_id: string | null;
      next_expected_seq: number; chain_tip_hash: string; consumed_at: string | null; expires_at: string;
    };

    if (new Date(s.expires_at) < new Date() && !s.consumed_at) {
      return NextResponse.json({ error: 'session expired' }, { status: 401 });
    }
    if (s.run_id !== p.runId || s.user_id !== claims.sub) {
      return NextResponse.json({ error: 'session mismatch' }, { status: 403 });
    }

    const stateBytes = canonicalJsonBytes(body.stateJson);
    const stateHash = sha256OfCanonical(body.stateJson);

    if (s.consumed_at) {
      // Idempotent retry path. Fetch the persisted runs row and verify
      // chainRoot/state hash match. If they do, return 200 without
      // duplicating audit events.
      const { data: runRow } = await supabase.from('runs')
        .select('events_chain_root, state_sha256').eq('id', p.runId).maybeSingle();
      const r = runRow as { events_chain_root: string | null; state_sha256: string | null } | null;
      if (!r) return NextResponse.json({ error: 'run row missing on idempotent retry' }, { status: 500 });
      if (r.events_chain_root !== body.chainRoot) {
        return NextResponse.json({ error: 'chain root mismatch on retry' }, { status: 409 });
      }
      if (r.state_sha256 !== stateHash) {
        return NextResponse.json({ error: 'state hash mismatch on retry' }, { status: 409 });
      }
      return NextResponse.json({
        runId: p.runId, sourceVerified: true, eventsChainRoot: r.events_chain_root,
      }, { status: 200 });
    }

    if (body.expectedChunkCount !== s.next_expected_seq) {
      return NextResponse.json({ error: 'chunk count mismatch' }, { status: 422 });
    }
    if (body.chainRoot !== s.chain_tip_hash) {
      return NextResponse.json({ error: 'chain root mismatch' }, { status: 409 });
    }
    if (s.next_expected_seq === 0) {
      return NextResponse.json({ error: 'no chunks uploaded' }, { status: 422 });
    }

    const scope = { organizationId: s.organization_id, userId: s.user_id };
    const indexPath = manifestPath(scope, p.runId);
    const sPath = statePath(scope, p.runId);

    // Build manifest from upload_session_chunks. Codex final CRITICAL —
    // require status='persisted', contiguous seq 0..N-1, last hash equals
    // chainRoot. Any deviation invalidates the run; refuse to mark
    // source_verified.
    const { data: chunkRows } = await supabase.from('upload_session_chunks')
      .select('seq, hash, bytes, storage_path, status')
      .eq('session_id', s.id);
    const chunks = (chunkRows as { seq: number; hash: string; bytes: number; storage_path: string; status: string }[] | null) ?? [];
    chunks.sort((a, b) => a.seq - b.seq);

    if (chunks.length !== s.next_expected_seq) {
      return NextResponse.json({ error: 'missing chunk rows' }, { status: 422 });
    }
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].seq !== i) {
        return NextResponse.json({ error: `non-contiguous seq at index ${i}` }, { status: 422 });
      }
      if (chunks[i].status !== 'persisted') {
        return NextResponse.json({ error: `chunk ${i} not persisted` }, { status: 422 });
      }
    }
    if (chunks[chunks.length - 1].hash !== body.chainRoot) {
      return NextResponse.json({ error: 'last chunk hash != chainRoot' }, { status: 409 });
    }

    const manifest = {
      version: 1,
      runId: p.runId,
      chainRoot: body.chainRoot,
      totalBytes: chunks.reduce((sum, c) => sum + c.bytes, 0),
      chunks: chunks.map((c) => ({ seq: c.seq, hash: c.hash, bytes: c.bytes })),
    };
    const manifestBytes = canonicalJsonBytes(manifest);

    // Storage idempotency: on duplicate, verify byte-equality before
    // advancing (codex final CRITICAL — silent advance allows state
    // divergence).
    try {
      await putObject(indexPath, manifestBytes, 'application/json');
    } catch (err) {
      if (err instanceof StorageWriteError && err.kind === 'duplicate') {
        const ok = await existingBytesEqual(indexPath, manifestBytes);
        if (!ok) return NextResponse.json({ error: 'manifest object diverges on retry' }, { status: 409 });
      } else {
        return NextResponse.json({ error: 'storage error (manifest)' }, { status: 500 });
      }
    }
    try {
      await putObject(sPath, stateBytes, 'application/json');
    } catch (err) {
      if (err instanceof StorageWriteError && err.kind === 'duplicate') {
        const ok = await existingBytesEqual(sPath, stateBytes);
        if (!ok) return NextResponse.json({ error: 'state object diverges on retry' }, { status: 409 });
      } else {
        return NextResponse.json({ error: 'storage error (state)' }, { status: 500 });
      }
    }

    await supabase.from('runs').update({
      events_chain_root: body.chainRoot,
      state_sha256: stateHash,
      events_blob_path: null,
      events_index_path: indexPath,
      state_blob_path: sPath,
      source_verified: true,
      upload_session_id: s.id,
    }).eq('id', p.runId);

    await supabase.from('upload_sessions').update({ consumed_at: new Date().toISOString() }).eq('id', s.id);

    await supabase.from('audit_events').insert({
      organization_id: s.organization_id,
      actor_user_id: s.user_id,
      action: 'run.uploaded',
      subject_type: 'run',
      subject_id: p.runId,
      metadata: { chunkCount: chunks.length, totalBytes: manifest.totalBytes, chainRoot: body.chainRoot },
      source_verified: true,
      prev_hash: null,
      this_hash: stateHash,
    });

    return NextResponse.json({
      runId: p.runId, sourceVerified: true, eventsChainRoot: body.chainRoot, manifestPath: indexPath,
    }, { status: 200 });
  });
}
