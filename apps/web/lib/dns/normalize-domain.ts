// Phase 5.6 — IDN-aware domain normalization shared by domain-claim,
// SSO sign-in start, and sso_required enforcement (codex spec pass-2
// WARNING #5).
//
// Routes call normalizeDomain or normalizeEmailDomain BEFORE passing the
// canonical domain to RPCs, so SQL doesn't need to re-implement
// normalization.

import { domainToASCII } from 'node:url';
import { getPublicSuffix } from 'tldts';

export type NormalizeResult = { ok: true; domain: string } | { ok: false; reason: string };

export function normalizeDomain(input: string): NormalizeResult {
  if (typeof input !== 'string' || input.length === 0 || input.length > 253) {
    return { ok: false, reason: 'invalid_input' };
  }
  const trimmed = input.trim().toLowerCase();
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(':') || trimmed.includes('@')) {
    return { ok: false, reason: 'must_be_bare_domain' };
  }
  const noTrailing = trimmed.replace(/\.+$/, '');
  const ascii = domainToASCII(noTrailing);
  if (ascii === '') return { ok: false, reason: 'invalid_format' };
  if (!ascii.includes('.')) return { ok: false, reason: 'must_have_tld' };
  const publicSuffix = getPublicSuffix(ascii, { allowPrivateDomains: true });
  if (publicSuffix === ascii) return { ok: false, reason: 'public_suffix_only' };
  return { ok: true, domain: ascii };
}

export function normalizeEmailDomain(email: string): NormalizeResult {
  if (typeof email !== 'string') return { ok: false, reason: 'invalid_input' };
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return { ok: false, reason: 'invalid_email' };
  return normalizeDomain(email.slice(at + 1));
}
