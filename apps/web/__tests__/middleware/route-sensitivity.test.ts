// apps/web/__tests__/middleware/route-sensitivity.test.ts
//
// v7.5.0 — route-sensitivity classifier tests.
//
// The classifier (`isHighSensitivityRoute`) determines whether the
// middleware skips the v7.0 Phase 6 cookie cache and always RPCs.
// HIGH = mutations + sensitive reads (audit, cost, sso, members,
// billing) + api-keys/*. LOW = everything else.
//
// Spec list (7 cases) plus codex pass-2 W4/W5 boundary cases.

import { describe, it, expect } from 'vitest';
import {
  HIGH_SENSITIVITY_PATTERNS,
  isHighSensitivityRoute,
} from '@/lib/middleware/route-sensitivity';

describe('v7.5.0 — isHighSensitivityRoute (spec cases)', () => {
  it('case 1: POST /api/dashboard/orgs/:id/members/:uid/disable → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/members/22222222-2222-2222-2222-222222222222/disable',
      'POST',
    )).toBe(true);
  });

  it('case 2: PATCH /api/dashboard/orgs/:id/members/:uid → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/members/22222222-2222-2222-2222-222222222222',
      'PATCH',
    )).toBe(true);
  });

  it('case 3: GET /api/dashboard/orgs/:id/audit → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/audit',
      'GET',
    )).toBe(true);
  });

  it('case 4: GET /api/dashboard/orgs/:id/cost.csv → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/cost.csv',
      'GET',
    )).toBe(true);
  });

  it('case 5: GET /api/dashboard/runs → low (cookie cache works)', () => {
    expect(isHighSensitivityRoute('/api/dashboard/runs', 'GET')).toBe(false);
  });

  it('case 6: GET /dashboard (page render) → low', () => {
    expect(isHighSensitivityRoute('/dashboard', 'GET')).toBe(false);
  });

  it('case 7: POST /api/dashboard/api-keys/revoke → high', () => {
    expect(isHighSensitivityRoute('/api/dashboard/api-keys/revoke', 'POST')).toBe(true);
  });
});

describe('v7.5.0 — non-GET methods on /api/dashboard/* are always high', () => {
  it('POST anywhere under /api/dashboard/* → high', () => {
    expect(isHighSensitivityRoute('/api/dashboard/runs/abc/visibility', 'POST')).toBe(true);
  });
  it('PATCH /api/dashboard/active-org → high (mutation)', () => {
    expect(isHighSensitivityRoute('/api/dashboard/active-org', 'PATCH')).toBe(true);
  });
  it('DELETE on any dashboard API → high', () => {
    expect(isHighSensitivityRoute('/api/dashboard/orgs/aa/sso', 'DELETE')).toBe(true);
  });
  it('PUT on any dashboard API → high', () => {
    expect(isHighSensitivityRoute('/api/dashboard/whatever', 'PUT')).toBe(true);
  });
  it('GET /api/dashboard/me → low (read-only)', () => {
    expect(isHighSensitivityRoute('/api/dashboard/me', 'GET')).toBe(false);
  });
  it('HEAD on dashboard API → low (treated like GET — no state change)', () => {
    // Intentional: HEAD/OPTIONS are non-mutating, default to LOW unless
    // explicitly listed in HIGH_SENSITIVITY_PATTERNS.
    expect(isHighSensitivityRoute('/api/dashboard/runs', 'HEAD')).toBe(false);
    expect(isHighSensitivityRoute('/api/dashboard/runs', 'OPTIONS')).toBe(false);
  });
  it('GET high-sensitivity pattern still wins regardless of method case', () => {
    expect(isHighSensitivityRoute('/api/dashboard/orgs/aaa/audit', 'get')).toBe(true);
  });
});

describe('v7.5.0 — boundary patterns (codex W5 — anchor regex correctness)', () => {
  it('GET /api/dashboard/orgs/:id/costume → LOW (cost prefix collision NOT matched)', () => {
    // The `cost` regex requires either a path terminator (`/` or end)
    // OR `.csv`. A made-up neighbouring segment must not match.
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/costume',
      'GET',
    )).toBe(false);
  });

  it('GET /api/dashboard/orgs/:id/auditor → LOW (audit prefix collision NOT matched)', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/auditor',
      'GET',
    )).toBe(false);
  });

  it('GET /api/dashboard/orgs/:id/audit/ (trailing slash) → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/audit/',
      'GET',
    )).toBe(true);
  });

  it('GET /api/dashboard/orgs/:id/audit/whatever (nested) → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/audit/2026-05',
      'GET',
    )).toBe(true);
  });

  it('GET /api/dashboard/orgs/:id/sso/domains/:domainId → high (nested SSO read)', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/sso/domains/22222222-2222-2222-2222-222222222222',
      'GET',
    )).toBe(true);
  });

  it('GET /api/dashboard/orgs/:id/members/:uid → high (sensitive member detail)', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/members/22222222-2222-2222-2222-222222222222',
      'GET',
    )).toBe(true);
  });

  it('GET /api/dashboard/api-keys (codex W4 — listing IS sensitive)', () => {
    expect(isHighSensitivityRoute('/api/dashboard/api-keys/', 'GET')).toBe(true);
    expect(isHighSensitivityRoute('/api/dashboard/api-keys/list', 'GET')).toBe(true);
  });

  it('GET /api/dashboard/api-keys-other-thing → LOW (api-keys NOT a prefix collision)', () => {
    // The api-keys pattern requires `/` or `$` after `api-keys`, so
    // `/api/dashboard/api-keys-other-thing` must NOT match.
    expect(isHighSensitivityRoute('/api/dashboard/api-keys-other-thing', 'GET')).toBe(false);
  });

  it('GET /api/dashboard/orgs/:id/billing/preview → high', () => {
    expect(isHighSensitivityRoute(
      '/api/dashboard/orgs/11111111-1111-1111-1111-111111111111/billing/preview',
      'GET',
    )).toBe(true);
  });
});

describe('v7.5.0 — pattern list integrity', () => {
  it('exports a non-empty HIGH_SENSITIVITY_PATTERNS array', () => {
    expect(Array.isArray(HIGH_SENSITIVITY_PATTERNS)).toBe(true);
    expect(HIGH_SENSITIVITY_PATTERNS.length).toBeGreaterThan(0);
  });

  it('every pattern is a RegExp anchored at start', () => {
    for (const re of HIGH_SENSITIVITY_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
      expect(re.source.startsWith('^')).toBe(true);
    }
  });

  it('non-/api paths are always low (page renders, root)', () => {
    expect(isHighSensitivityRoute('/', 'GET')).toBe(false);
    expect(isHighSensitivityRoute('/login', 'POST')).toBe(false);
    expect(isHighSensitivityRoute('/dashboard/orgs/select', 'GET')).toBe(false);
    expect(isHighSensitivityRoute('/dashboard/admin/members', 'GET')).toBe(false);
  });
});
