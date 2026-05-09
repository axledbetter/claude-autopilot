// Phase 5.7 — exercise the cleanup_expired_sso_states RPC handler
// directly (not the script — script is a thin wrapper).

import { describe, it, expect, beforeEach } from 'vitest';
import { stub } from '../_helpers/supabase-stub';

beforeEach(() => {
  stub.reset();
});

describe('cleanup_expired_sso_states RPC', () => {
  it('default args succeed with empty tables', async () => {
    const client = stub.asClient();
    const { data, error } = await client.rpc('cleanup_expired_sso_states', {
      p_state_age_hours: 24,
      p_event_age_days: 30,
    });
    expect(error).toBe(null);
    expect(data).toEqual({ expiredStatesDeleted: 0, oldEventsDeleted: 0 });
  });

  it('out-of-range state-age → invalid_state_age', async () => {
    const client = stub.asClient();
    const { error } = await client.rpc('cleanup_expired_sso_states', {
      p_state_age_hours: 0,
      p_event_age_days: 30,
    });
    expect(error?.message).toBe('invalid_state_age');
  });

  it('out-of-range event-age → invalid_event_age', async () => {
    const client = stub.asClient();
    const { error } = await client.rpc('cleanup_expired_sso_states', {
      p_state_age_hours: 24,
      p_event_age_days: 366,
    });
    expect(error?.message).toBe('invalid_event_age');
  });

  it('deletes consumed states older than threshold', async () => {
    stub.seed('sso_authentication_states', [
      // Old consumed → delete
      { id: 'old', nonce: 'x', organization_id: 'org', workos_organization_id: 'wos', workos_connection_id: 'conn', expires_at: new Date().toISOString(), consumed_at: new Date(Date.now() - 48 * 3600_000).toISOString(), created_at: new Date().toISOString() },
      // Recent consumed → keep
      { id: 'recent', nonce: 'x', organization_id: 'org', workos_organization_id: 'wos', workos_connection_id: 'conn', expires_at: new Date().toISOString(), consumed_at: new Date().toISOString(), created_at: new Date().toISOString() },
      // Old unconsumed expired → delete
      { id: 'expired', nonce: 'x', organization_id: 'org', workos_organization_id: 'wos', workos_connection_id: 'conn', expires_at: new Date(Date.now() - 48 * 3600_000).toISOString(), consumed_at: null, created_at: new Date().toISOString() },
      // Active → keep
      { id: 'active', nonce: 'x', organization_id: 'org', workos_organization_id: 'wos', workos_connection_id: 'conn', expires_at: new Date(Date.now() + 600_000).toISOString(), consumed_at: null, created_at: new Date().toISOString() },
    ]);
    const client = stub.asClient();
    const { data } = await client.rpc('cleanup_expired_sso_states', { p_state_age_hours: 24, p_event_age_days: 30 });
    expect(data).toMatchObject({ expiredStatesDeleted: 2 });
    const remaining = stub.tables.get('sso_authentication_states') ?? [];
    expect(remaining.map((r) => r.id).sort()).toEqual(['active', 'recent']);
  });

  it('deletes processed_workos_events older than threshold', async () => {
    stub.seed('processed_workos_events', [
      { event_id: 'old', event_type: 'connection.activated', payload_hash: 'x', status: 'processed', processed_at: new Date(Date.now() - 60 * 86400_000).toISOString() },
      { event_id: 'recent', event_type: 'connection.activated', payload_hash: 'x', status: 'processed', processed_at: new Date().toISOString() },
    ]);
    const client = stub.asClient();
    const { data } = await client.rpc('cleanup_expired_sso_states', { p_state_age_hours: 24, p_event_age_days: 30 });
    expect(data).toMatchObject({ oldEventsDeleted: 1 });
    const remaining = stub.tables.get('processed_workos_events') ?? [];
    expect(remaining.map((r) => r.event_id)).toEqual(['recent']);
  });
});
