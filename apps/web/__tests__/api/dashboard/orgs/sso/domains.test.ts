import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { stub } from '../../../../_helpers/supabase-stub';

vi.mock('@/lib/supabase/service', () => ({ createServiceRoleClient: () => stub.asClient() }));
let currentUser: { id: string } | null = null;
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: currentUser } }) } }),
}));

let nextResolveTxt: (fqdn: string) => Promise<string[][]>;
vi.mock('node:dns/promises', () => ({
  default: { resolveTxt: (fqdn: string) => nextResolveTxt(fqdn) },
  resolveTxt: (fqdn: string) => nextResolveTxt(fqdn),
}));

const { POST: addDomain } = await import('@/app/api/dashboard/orgs/[orgId]/sso/domains/route');
const { DELETE: revokeDomain } = await import('@/app/api/dashboard/orgs/[orgId]/sso/domains/[domainId]/route');
const { POST: verifyDomain } = await import('@/app/api/dashboard/orgs/[orgId]/sso/domains/[domainId]/verify/route');

beforeEach(() => {
  stub.reset();
  currentUser = null;
  nextResolveTxt = async () => [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://stub';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
  process.env.AUTOPILOT_PUBLIC_BASE_URL = 'https://autopilot.dev';
});

function reqAdd(orgId: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso/domains`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://autopilot.dev', ...headers },
    body: JSON.stringify(body),
  });
}

function reqDelete(orgId: string, domainId: string): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso/domains/${domainId}`, {
    method: 'DELETE',
    headers: { origin: 'https://autopilot.dev' },
  });
}

function reqVerify(orgId: string, domainId: string): Request {
  return new Request(`http://x/api/dashboard/orgs/${orgId}/sso/domains/${domainId}/verify`, {
    method: 'POST',
    headers: { origin: 'https://autopilot.dev' },
  });
}

function seedAdmin(orgId: string, role: 'owner' | 'admin' = 'owner'): string {
  const userId = randomUUID();
  stub.seed('memberships', [{
    id: randomUUID(), organization_id: orgId, user_id: userId,
    role, status: 'active', joined_at: new Date().toISOString(),
  }]);
  stub.seed('organizations', [{ id: orgId, name: 'A' }]);
  return userId;
}

describe('domain claim routes', () => {
  it('test 1: owner adds domain → 200, status pending, returns challenge', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const r = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.domain).toBe('acme.com');
    expect(body.status).toBe('pending');
    expect(body.challengeRecordName).toBe('_workos-verify.acme.com');
    expect(body.challengeRecordValue).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test 2: member tries → 403 not_admin', async () => {
    const orgId = randomUUID();
    const memberUser = randomUUID();
    stub.seed('memberships', [{
      id: randomUUID(), organization_id: orgId, user_id: memberUser,
      role: 'member', status: 'active', joined_at: new Date().toISOString(),
    }]);
    stub.seed('organizations', [{ id: orgId, name: 'A' }]);
    currentUser = { id: memberUser };
    const r = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    expect(r.status).toBe(403);
  });

  it('test 3: domain normalized — Acme.COM → stored as acme.com', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const r = await addDomain(reqAdd(orgId, { domain: 'Acme.COM' }), { params: { orgId } });
    expect(r.status).toBe(200);
    expect((await r.json()).domain).toBe('acme.com');
  });

  it('test 4: pending claim in same org for same domain → 409 domain_already_pending', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    const r2 = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toBe('domain_already_pending');
  });

  it('test 5: verified claim in another org → 422 domain_already_claimed', async () => {
    const orgA = randomUUID();
    const ownerA = seedAdmin(orgA);
    stub.seed('organization_domain_claims', [{
      id: randomUUID(),
      organization_id: orgA,
      domain: 'acme.com',
      status: 'verified',
      ever_verified: true,
      challenge_token: 'a'.repeat(64),
      verified_at: new Date().toISOString(),
      created_by: ownerA,
      created_at: new Date().toISOString(),
    }]);
    const orgB = randomUUID();
    const ownerB = seedAdmin(orgB);
    currentUser = { id: ownerB };
    const r = await addDomain(reqAdd(orgB, { domain: 'acme.com' }), { params: { orgB } as { orgB: string } as never });
    // The route uses orgB as orgId.
    const r2 = await addDomain(reqAdd(orgB, { domain: 'acme.com' }), { params: { orgId: orgB } });
    expect(r2.status).toBe(422);
    expect((await r2.json()).error).toBe('domain_already_claimed');
    void r;
  });

  it('test 6: revoke verified claim → 200, status revoked', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    const claimId = randomUUID();
    stub.seed('organization_domain_claims', [{
      id: claimId, organization_id: orgId, domain: 'acme.com',
      status: 'verified', ever_verified: true,
      challenge_token: 'a'.repeat(64), verified_at: new Date().toISOString(),
      created_by: owner, created_at: new Date().toISOString(),
    }]);
    currentUser = { id: owner };
    const r = await revokeDomain(reqDelete(orgId, claimId), { params: { orgId, domainId: claimId } });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('revoked');
  });

  it('test 7: DNS TXT matches challenge → 200 verified', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const add = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    const addBody = await add.json();
    nextResolveTxt = async (fqdn) => fqdn === '_workos-verify.acme.com' ? [[addBody.challengeRecordValue]] : [];
    const r = await verifyDomain(reqVerify(orgId, addBody.id), { params: { orgId, domainId: addBody.id } });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('verified');
  });

  it('test 8: DNS TXT doesn\'t match → 422 verification_failed', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const add = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    const addBody = await add.json();
    nextResolveTxt = async () => [['wrong-token']];
    const r = await verifyDomain(reqVerify(orgId, addBody.id), { params: { orgId, domainId: addBody.id } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('verification_failed');
  });

  it('test 9: NXDOMAIN → 422 with reason', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const add = await addDomain(reqAdd(orgId, { domain: 'acme.com' }), { params: { orgId } });
    const addBody = await add.json();
    nextResolveTxt = async () => {
      const e = new Error('not found') as Error & { code: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
    const r = await verifyDomain(reqVerify(orgId, addBody.id), { params: { orgId, domainId: addBody.id } });
    expect(r.status).toBe(422);
    expect((await r.json()).reason).toBe('no_txt_records');
  });

  it('codex CRITICAL #1: revoked-then-attacker-tries → 422 domain_already_claimed', async () => {
    const orgA = randomUUID();
    const ownerA = seedAdmin(orgA);
    stub.seed('organization_domain_claims', [{
      id: randomUUID(),
      organization_id: orgA,
      domain: 'acme.com',
      status: 'revoked',  // revoked, but ever_verified=true
      ever_verified: true,
      challenge_token: 'a'.repeat(64),
      verified_at: new Date(Date.now() - 60_000).toISOString(),
      revoked_at: new Date().toISOString(),
      created_by: ownerA,
      created_at: new Date().toISOString(),
    }]);
    const orgB = randomUUID();
    const ownerB = seedAdmin(orgB);
    currentUser = { id: ownerB };
    const r = await addDomain(reqAdd(orgB, { domain: 'acme.com' }), { params: { orgId: orgB } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('domain_already_claimed');
  });

  it('invalid domain (TLD only) → 422 invalid_domain', async () => {
    const orgId = randomUUID();
    const owner = seedAdmin(orgId);
    currentUser = { id: owner };
    const r = await addDomain(reqAdd(orgId, { domain: 'com' }), { params: { orgId } });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('invalid_domain');
  });
});
