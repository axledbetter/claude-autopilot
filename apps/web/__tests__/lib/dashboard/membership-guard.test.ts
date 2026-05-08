import { describe, it, expect } from 'vitest';
import { mapPostgresError, isValidUuid } from '@/lib/dashboard/membership-guard';

describe('mapPostgresError', () => {
  it('maps not_admin → 403', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'not_admin' })).toEqual({ status: 403, body: { error: 'not_admin' } });
  });
  it('maps not_owner → 403', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'not_owner' })).toEqual({ status: 403, body: { error: 'not_owner' } });
  });
  it('maps user_not_found → 404', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'user_not_found' })).toEqual({ status: 404, body: { error: 'user_not_found' } });
  });
  it('maps target_not_member → 404', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'target_not_member' })).toEqual({ status: 404, body: { error: 'target_not_member' } });
  });
  it('maps already_member → 409', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'already_member' })).toEqual({ status: 409, body: { error: 'already_member' } });
  });
  it('maps last_owner → 422', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'last_owner' })).toEqual({ status: 422, body: { error: 'last_owner' } });
  });
  it('maps role_transition → 422', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'role_transition' })).toEqual({ status: 422, body: { error: 'role_transition' } });
  });
  it('maps bad_role → 422', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'bad_role' })).toEqual({ status: 422, body: { error: 'bad_role' } });
  });
  it('maps bad_name → 422', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'bad_name' })).toEqual({ status: 422, body: { error: 'bad_name' } });
  });
  it('unmapped P0001 → 500', () => {
    expect(mapPostgresError({ code: 'P0001', message: 'wat' })).toEqual({ status: 500, body: { error: 'internal' } });
  });
  it('non-P0001 → 500', () => {
    expect(mapPostgresError({ code: '23505', message: 'duplicate key' })).toEqual({ status: 500, body: { error: 'internal' } });
  });
  it('42501 privilege denied → 500 internal (no leak)', () => {
    expect(mapPostgresError({ code: '42501', message: 'permission denied for function invite_member' })).toEqual({ status: 500, body: { error: 'internal' } });
  });
});

describe('isValidUuid', () => {
  it('accepts a valid uuid', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
  it('rejects null', () => { expect(isValidUuid(null)).toBe(false); });
  it('rejects undefined', () => { expect(isValidUuid(undefined)).toBe(false); });
  it('rejects garbage', () => { expect(isValidUuid('not-a-uuid')).toBe(false); });
});
