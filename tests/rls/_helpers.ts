// tests/rls/_helpers.ts
//
// Shared helpers for v7.0 Phase 1 RLS tests.
//
// Each test gets:
//   - Fresh DB state (db reset between test files via `npm run db:reset`
//     in the CI workflow; locally devs must reset manually).
//   - Fresh users via supabase.auth.admin.createUser (service-role client).
//   - Per-user Supabase clients to exercise RLS as that user.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY required. ' +
    'Run `bash scripts/db/start-supabase.sh` to print them.'
  );
}

export const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

/** Create a fresh user + return a per-user authenticated client. */
export async function createTestUser(label: string = 'user'): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@cert.local`;
  const password = randomUUID();
  const { data, error } = await serviceClient.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser returned no user');

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;

  return { id: data.user.id, email, client };
}

/** Create an org + add the given users with the given roles. */
export async function createOrgWithMembers(
  slug: string,
  members: Array<{ user: TestUser; role: 'owner'|'admin'|'member'; status?: 'active'|'disabled'|'removed' }>,
): Promise<string> {
  const { data: org, error } = await serviceClient
    .from('organizations')
    .insert({ slug, name: slug })
    .select('id')
    .single();
  if (error || !org) throw error ?? new Error('createOrg returned no row');

  for (const m of members) {
    const { error: mErr } = await serviceClient.from('memberships').insert({
      organization_id: org.id,
      user_id: m.user.id,
      role: m.role,
      status: m.status ?? 'active',
    });
    if (mErr) throw mErr;
  }
  return org.id;
}

/** Create a run via service_role (bypasses RLS — represents server-side ingest). */
export async function createRunAsServer(args: {
  runId: string;
  organizationId: string | null;
  userId: string;
  status?: 'running' | 'success' | 'failed';
  visibility?: 'private' | 'public' | 'org';
}): Promise<void> {
  const { error } = await serviceClient.from('runs').insert({
    id: args.runId,
    organization_id: args.organizationId,
    user_id: args.userId,
    cli_version: '6.3.0-pre.1-test',
    started_at: new Date().toISOString(),
    status: args.status ?? 'success',
    visibility: args.visibility ?? 'private',
  });
  if (error) throw error;
}

/** Truncate all v7.0 tables. Calls public.test_reset_all_tables() —
 *  service-role only; defined alongside audit.append() in migration 0006.
 *  CI runs `db:reset` between test files; this helper is for in-test isolation. */
export async function resetTables(): Promise<void> {
  const { error } = await serviceClient.rpc('test_reset_all_tables');
  if (error) throw error;
}
