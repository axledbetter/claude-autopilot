import { describe, it, expect } from 'vitest';
import { normalizeDomain, normalizeEmailDomain } from '@/lib/dns/normalize-domain';

describe('normalizeDomain', () => {
  it('plain domain', () => {
    expect(normalizeDomain('example.com')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('uppercase normalized to lowercase', () => {
    expect(normalizeDomain('Example.COM')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('IDN converted to punycode', () => {
    const r = normalizeDomain('münchen.de');
    expect(r).toEqual({ ok: true, domain: 'xn--mnchen-3ya.de' });
  });
  it('trailing dot stripped', () => {
    expect(normalizeDomain('example.com.')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('URL with scheme rejected', () => {
    expect(normalizeDomain('https://example.com')).toEqual({ ok: false, reason: 'must_be_bare_domain' });
  });
  it('port rejected', () => {
    expect(normalizeDomain('example.com:8080')).toEqual({ ok: false, reason: 'must_be_bare_domain' });
  });
  it('path rejected', () => {
    expect(normalizeDomain('example.com/foo')).toEqual({ ok: false, reason: 'must_be_bare_domain' });
  });
  it('@ rejected', () => {
    expect(normalizeDomain('user@example.com')).toEqual({ ok: false, reason: 'must_be_bare_domain' });
  });
  it('TLD only rejected', () => {
    expect(normalizeDomain('com')).toEqual({ ok: false, reason: 'must_have_tld' });
  });
  it('public suffix only rejected (co.uk)', () => {
    expect(normalizeDomain('co.uk')).toEqual({ ok: false, reason: 'public_suffix_only' });
  });
  it('localhost rejected', () => {
    expect(normalizeDomain('localhost')).toEqual({ ok: false, reason: 'must_have_tld' });
  });
  it('empty rejected', () => {
    expect(normalizeDomain('')).toEqual({ ok: false, reason: 'invalid_input' });
  });
  it('non-string rejected', () => {
    expect(normalizeDomain(null as unknown as string)).toEqual({ ok: false, reason: 'invalid_input' });
  });
  it('valid private subdomain accepted', () => {
    expect(normalizeDomain('app.acme.co.uk')).toEqual({ ok: true, domain: 'app.acme.co.uk' });
  });
});

describe('normalizeEmailDomain', () => {
  it('happy path', () => {
    expect(normalizeEmailDomain('alice@example.com')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('mixed-case email lowercased', () => {
    expect(normalizeEmailDomain('User@EXAMPLE.com')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('no @ rejected', () => {
    expect(normalizeEmailDomain('alice')).toEqual({ ok: false, reason: 'invalid_email' });
  });
  it('trailing @ rejected', () => {
    expect(normalizeEmailDomain('alice@')).toEqual({ ok: false, reason: 'invalid_email' });
  });
  it('leading @ rejected', () => {
    expect(normalizeEmailDomain('@example.com')).toEqual({ ok: false, reason: 'invalid_email' });
  });
});
