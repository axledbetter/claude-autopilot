import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));

const { enforceSsoRequired } = await import('@/lib/auth/enforce-sso-required');

beforeEach(() => {
  stub.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
});

function seedClaim(orgId: string, domain: string, status = 'verified', settings: Record<string, unknown> = {}): void {
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  stub.seed('organization_domain_claims', [{
    id: randomUUID(),
    organization_id: orgId,
    domain,
    status,
    ever_verified: status === 'verified',
  }]);
  stub.seed('organization_settings', [{
    organization_id: orgId,
    sso_required: false,
    sso_connection_status: 'inactive',
    ...settings,
  }]);
}

describe('enforceSsoRequired', () => {
  it('null email → allow', async () => {
    expect(await enforceSsoRequired(null)).toEqual({ action: 'allow' });
  });

  it('malformed email → allow', async () => {
    expect(await enforceSsoRequired('garbage')).toEqual({ action: 'allow' });
  });

  it('domain not claimed → allow', async () => {
    expect(await enforceSsoRequired('alice@unclaimed.com')).toEqual({ action: 'allow' });
  });

  it('domain claimed, sso_required=false → allow', async () => {
    const orgId = randomUUID();
    seedClaim(orgId, 'acme.com', 'verified', { sso_required: false, sso_connection_status: 'active' });
    expect(await enforceSsoRequired('alice@acme.com')).toEqual({ action: 'allow' });
  });

  it('domain claimed, sso_required=true, status=active → redirect_to_sso', async () => {
    const orgId = randomUUID();
    seedClaim(orgId, 'acme.com', 'verified', { sso_required: true, sso_connection_status: 'active' });
    const r = await enforceSsoRequired('Alice@Acme.COM');
    expect(r).toEqual({ action: 'redirect_to_sso', email: 'Alice@Acme.COM' });
  });

  it('domain claimed, sso_required=true, status=disabled → allow (codex pass-2 NOTE #2)', async () => {
    const orgId = randomUUID();
    seedClaim(orgId, 'acme.com', 'verified', { sso_required: true, sso_connection_status: 'disabled' });
    expect(await enforceSsoRequired('alice@acme.com')).toEqual({ action: 'allow' });
  });

  it('formerly verified, now revoked → allow (codex plan-pass WARNING #8 — predicate uses status, not ever_verified)', async () => {
    const orgId = randomUUID();
    seedClaim(orgId, 'acme.com', 'revoked', { sso_required: true, sso_connection_status: 'active' });
    expect(await enforceSsoRequired('alice@acme.com')).toEqual({ action: 'allow' });
  });
});
