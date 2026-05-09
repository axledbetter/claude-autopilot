// apps/web/__tests__/lib/upload/membership-recheck.test.ts
//
// v7.1 spec test #4 — assertActiveMembership() helper unit tests.
//
// Coverage:
//   - 5 status enum cases (active, disabled, inactive, invite_pending, no_row)
//   - 1 unknown-status default → IngestMembershipError('member_check_failed')
//     (codex pass-1 CRITICAL #1 fail-closed)
//   - 1 RPC-error → IngestMembershipError('member_check_failed')
//   - 1 personal-shortcut (org_id absent / null / empty)
//   - 1 v7.0-back-compat (no mint_status claim, org_id present → still
//     calls RPC per CRITICAL #2)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertActiveMembership,
  IngestMembershipError,
} from '@/lib/upload/membership-recheck';
import * as checkModule from '@/lib/supabase/check-membership';
import type { UploadTokenClaims } from '@/lib/upload/jwt';

const ORG = '11111111-2222-3333-4444-555555555555';
const USER = '99999999-8888-7777-6666-555555555555';

function claimsWith(overrides: Partial<UploadTokenClaims> = {}): UploadTokenClaims {
  return {
    sub: USER,
    run_id: '01HQK8' + 'A'.repeat(20),
    org_id: ORG,
    jti: 'jti-1',
    aud: 'claude-autopilot-upload',
    iss: 'autopilot.dev',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    mint_status: 'active',
    ...overrides,
  };
}

describe('assertActiveMembership — status dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('status=active → resolves (no throw)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'active', role: 'owner', checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).resolves.toBeUndefined();
  });

  it('status=disabled → throws IngestMembershipError(member_disabled)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'disabled', role: 'member', checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'member_disabled',
    });
  });

  it('status=inactive → throws IngestMembershipError(member_inactive)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'inactive', role: 'member', checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'member_inactive',
    });
  });

  it('status=invite_pending → throws IngestMembershipError(member_inactive)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'invite_pending', role: null, checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'member_inactive',
    });
  });

  it('status=no_row → throws IngestMembershipError(no_membership)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'no_row', role: null, checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'no_membership',
    });
  });

  it('codex pass-1 CRITICAL #1 — unknown status → throws member_check_failed (fail-closed)', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      // Cast through unknown so TypeScript allows the bogus status; the
      // runtime check is what matters.
      status: 'fabricated_new_status' as unknown as 'active', role: null, checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'member_check_failed',
    });
  });

  it('RPC error (MembershipCheckError) → throws member_check_failed', async () => {
    vi.spyOn(checkModule, 'checkMembershipStatus').mockRejectedValue(
      new checkModule.MembershipCheckError({ code: 'check_failed', message: 'simulated outage' }),
    );
    await expect(assertActiveMembership(claimsWith())).rejects.toBeInstanceOf(IngestMembershipError);
    await expect(assertActiveMembership(claimsWith())).rejects.toMatchObject({
      reason: 'member_check_failed',
    });
  });

  it('personal-run shortcut: org_id null → resolves WITHOUT calling RPC', async () => {
    const spy = vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'active', role: 'owner', checkedAt: 0,
    });
    await expect(assertActiveMembership(claimsWith({ org_id: null }))).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('codex pass-1 CRITICAL #2 — v7.0 token (no mint_status), org_id present → STILL calls RPC', async () => {
    const spy = vi.spyOn(checkModule, 'checkMembershipStatus').mockResolvedValue({
      status: 'disabled', role: 'member', checkedAt: 0,
    });
    // Strip mint_status to simulate v7.0 token shape.
    const v70Claims = claimsWith({ org_id: ORG });
    delete (v70Claims as Partial<UploadTokenClaims>).mint_status;
    await expect(assertActiveMembership(v70Claims)).rejects.toMatchObject({
      reason: 'member_disabled',
    });
    expect(spy).toHaveBeenCalledWith(ORG, USER);
  });
});
