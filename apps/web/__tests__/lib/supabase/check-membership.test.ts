// apps/web/__tests__/lib/supabase/check-membership.test.ts
//
// v7.0 Phase 6 — spec test #9.
// (a) helper validates UUIDs BEFORE touching Supabase
// (b) valid call returns {status, role}
// (c) RPC error → MembershipCheckError with code 'check_failed'
//     (distinct from member_disabled per codex pass-2 WARNING #4)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkMembershipStatus,
  MembershipCheckError,
} from '@/lib/supabase/check-membership';
import * as svc from '@/lib/supabase/service';

const VALID_ORG = '11111111-2222-3333-4444-555555555555';
const VALID_USER = '99999999-8888-7777-6666-555555555555';

describe('checkMembershipStatus', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
    svc._resetServiceClientForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    svc._resetServiceClientForTests();
  });

  describe('test #9(a) — UUID validation BEFORE RPC', () => {
    it('throws invalid_org_id for non-UUID orgId without touching Supabase', async () => {
      const spy = vi.spyOn(svc, 'createServiceRoleClient').mockImplementation(() => {
        throw new Error('createServiceRoleClient must NOT be called for invalid UUID');
      });
      try {
        await checkMembershipStatus('not-a-uuid', VALID_USER);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('invalid_org_id');
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('throws invalid_user_id for non-UUID userId without touching Supabase', async () => {
      const spy = vi.spyOn(svc, 'createServiceRoleClient').mockImplementation(() => {
        throw new Error('createServiceRoleClient must NOT be called for invalid UUID');
      });
      try {
        await checkMembershipStatus(VALID_ORG, 'not-a-uuid');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('invalid_user_id');
      }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('test #9(b) — happy path returns {status, role}', () => {
    it('returns active/owner from a successful RPC', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: { status: 'active', role: 'owner', checked_at: 1234567890 },
          error: null,
        }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      const result = await checkMembershipStatus(VALID_ORG, VALID_USER);
      expect(result.status).toBe('active');
      expect(result.role).toBe('owner');
      expect(result.checkedAt).toBe(1234567890);
    });

    it('normalizes no_row synthetic status', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: { status: 'no_row', role: null, checked_at: 1234567890 },
          error: null,
        }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      const result = await checkMembershipStatus(VALID_ORG, VALID_USER);
      expect(result.status).toBe('no_row');
      expect(result.role).toBeNull();
    });

    it('normalizes disabled status', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: { status: 'disabled', role: 'member', checked_at: 1234567890 },
          error: null,
        }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      const result = await checkMembershipStatus(VALID_ORG, VALID_USER);
      expect(result.status).toBe('disabled');
      expect(result.role).toBe('member');
    });
  });

  describe('test #9(c) — RPC error → check_failed (distinct from member_disabled)', () => {
    it('wraps RPC error in MembershipCheckError(check_failed)', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'function does not exist', code: '42883' },
        }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      try {
        await checkMembershipStatus(VALID_ORG, VALID_USER);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('check_failed');
        // Codex pass-2 WARNING #4: NOT member_disabled — operator can grep
        // for check_failed in logs to distinguish backend issues.
        expect((err as MembershipCheckError).code).not.toBe('member_disabled' as never);
      }
    });

    it('wraps RPC throw in MembershipCheckError(check_failed)', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockImplementation(() => {
          throw new Error('network down');
        }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      try {
        await checkMembershipStatus(VALID_ORG, VALID_USER);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('check_failed');
      }
    });

    it('wraps malformed RPC response in MembershipCheckError(check_failed)', async () => {
      vi.spyOn(svc, 'createServiceRoleClient').mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: 'not-an-object', error: null }),
      } as unknown as ReturnType<typeof svc.createServiceRoleClient>);

      try {
        await checkMembershipStatus(VALID_ORG, VALID_USER);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipCheckError);
        expect((err as MembershipCheckError).code).toBe('check_failed');
      }
    });
  });
});
