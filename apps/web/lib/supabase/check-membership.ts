// apps/web/lib/supabase/check-membership.ts
//
// Phase 6 — narrow service-role wrapper around the
// `check_membership_status(p_org_id, p_user_id)` RPC. Used by the
// dashboard middleware on every cache-miss.
//
// Codex pass-1 WARNING #2: validate UUIDs BEFORE hitting Supabase. The
// RPC + REVOKE/GRANT only allow service_role, but defense-in-depth at
// the helper level avoids the RPC ever seeing arbitrary inputs from
// cookies.
//
// Codex pass-3 WARNING #3: hard 1.5s timeout on the RPC call. Bounds
// middleware latency on every dashboard request. Timeout emits
// MembershipCheckError({code: 'check_failed', subcode: 'timeout'}).
//
// Codex pass-2 WARNING #4: distinguishes RPC errors (check_failed) from
// negative-but-valid results (status='disabled'/'inactive'/'no_row').
// The middleware uses different reason codes for each.

import { createServiceRoleClient } from './service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RPC_TIMEOUT_MS = 1500;

export type MembershipStatus =
  | 'active'
  | 'disabled'
  | 'inactive'
  | 'invite_pending'
  | 'no_row';

export type MembershipRole = 'owner' | 'admin' | 'member' | null;

export interface MembershipCheckResult {
  status: MembershipStatus;
  role: MembershipRole;
  /** Epoch seconds when the RPC reported the read. */
  checkedAt: number;
}

export type MembershipCheckErrorCode =
  | 'invalid_org_id'
  | 'invalid_user_id'
  | 'cookie_secret_missing'
  | 'check_failed';

export interface MembershipCheckErrorOptions {
  code: MembershipCheckErrorCode;
  subcode?: string;
  message?: string;
  cause?: unknown;
}

export class MembershipCheckError extends Error {
  readonly code: MembershipCheckErrorCode;
  readonly subcode?: string;
  override readonly cause?: unknown;
  constructor(opts: MembershipCheckErrorOptions) {
    super(opts.message ?? opts.code);
    this.name = 'MembershipCheckError';
    this.code = opts.code;
    if (opts.subcode !== undefined) this.subcode = opts.subcode;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

function isValidUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Race the RPC call against a timeout. The timeout rejects with
 *  MembershipCheckError(check_failed, subcode=timeout). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MembershipCheckError({
        code: 'check_failed',
        subcode: 'timeout',
        message: `check_membership_status RPC exceeded ${ms}ms`,
      }));
    }, ms);
  });
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    timeout,
  ]);
}

interface RpcRow {
  status: string;
  role: string | null;
  checked_at: number;
}

function normalizeStatus(raw: string): MembershipStatus {
  switch (raw) {
    case 'active':
    case 'disabled':
    case 'inactive':
    case 'invite_pending':
    case 'no_row':
      return raw;
    default:
      // Unknown enum value from DB — treat as no_row (revoke).
      return 'no_row';
  }
}

function normalizeRole(raw: string | null): MembershipRole {
  if (raw === 'owner' || raw === 'admin' || raw === 'member') return raw;
  return null;
}

/**
 * Look up the current membership status + role for (orgId, userId) via
 * the `check_membership_status` RPC (SECURITY INVOKER, service_role
 * grant only). Always returns one row — the RPC synthesizes a 'no_row'
 * status when there's no membership for the (org, user) pair.
 *
 * Throws MembershipCheckError on:
 *   - invalid_org_id / invalid_user_id (UUID guard, BEFORE RPC)
 *   - check_failed (RPC error, network, missing migration, timeout)
 */
export async function checkMembershipStatus(
  orgId: string,
  userId: string,
): Promise<MembershipCheckResult> {
  if (!isValidUuid(orgId)) {
    throw new MembershipCheckError({
      code: 'invalid_org_id',
      message: `orgId is not a valid UUID: ${JSON.stringify(orgId)}`,
    });
  }
  if (!isValidUuid(userId)) {
    throw new MembershipCheckError({
      code: 'invalid_user_id',
      message: `userId is not a valid UUID: ${JSON.stringify(userId)}`,
    });
  }

  const supabase = createServiceRoleClient();
  let rpcResult: { data: unknown; error: { message: string; code?: string } | null };
  try {
    // Wrap in Promise.resolve so the awaitable PostgrestBuilder fits
    // the Promise generic that withTimeout expects.
    rpcResult = await withTimeout(
      Promise.resolve(supabase.rpc('check_membership_status', {
        p_org_id: orgId,
        p_user_id: userId,
      })) as Promise<{ data: unknown; error: { message: string; code?: string } | null }>,
      RPC_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof MembershipCheckError) throw err;
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: 'rpc_threw',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  if (rpcResult.error) {
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: rpcResult.error.code ?? 'rpc_error',
      message: rpcResult.error.message,
      cause: rpcResult.error,
    });
  }

  const row = rpcResult.data as RpcRow | null;
  if (!row || typeof row !== 'object') {
    throw new MembershipCheckError({
      code: 'check_failed',
      subcode: 'malformed_rpc_response',
      message: `check_membership_status returned a non-object: ${JSON.stringify(row)}`,
    });
  }

  return {
    status: normalizeStatus(String(row.status)),
    role: normalizeRole(row.role ?? null),
    checkedAt: typeof row.checked_at === 'number' ? row.checked_at : Math.floor(Date.now() / 1000),
  };
}
