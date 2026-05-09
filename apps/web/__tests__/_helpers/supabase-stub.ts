// Supabase stub for route tests.
//
// This is the in-memory test seam wired into routes via:
//   vi.mock('@/lib/supabase/service', () => ({
//     createServiceRoleClient: () => stub.asClient(),
//     _resetServiceClientForTests: () => stub.reset(),
//   }));
//
// The stub:
// - Implements just-enough `from('table').select/insert/update/delete` chain
//   semantics for the routes' queries.
// - Implements `.rpc('claim_chunk_slot' | 'mark_chunk_persisted', args)`
//   mirroring the SQL functions exactly.
// - Implements Storage `upload(path, body, { upsert })` returning a
//   409-shaped error when `upsert: false` and path exists, and `download(path)`
//   returning the stored bytes.
// - Implements `FOR UPDATE` semantics via an async mutex per session jti, so
//   concurrent test invocations serialize on the same session.

import { _setTransactionHookForTests } from '@/lib/upload/transaction';

type Row = Record<string, unknown>;

type StubError = { message: string; code?: string; statusCode?: string } | null;

interface StubResult<T> { data: T; error: StubError }

class Mutex {
  private chain: Promise<void> = Promise.resolve();
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prev = this.chain;
    this.chain = next;
    await prev;
    try { return await fn(); } finally { release(); }
  }
}

class TableQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private op: { kind: 'select' | 'insert' | 'update' | 'delete'; payload?: unknown } | null = null;
  private countOnly = false;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;

  constructor(private stub: SupabaseStub, private table: string) {}

  // Real supabase-js: .select() after .update()/.insert()/.delete() returns
  // the rows mutated. Don't overwrite the op in that case.
  select(_cols = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    if (!this.op) this.op = { kind: 'select' };
    if (opts?.head === true) this.countOnly = true;
    return this;
  }

  // Phase 4 — order/range support for paginated runs lists.
  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orderCol = col;
    this.orderAsc = opts.ascending !== false;
    return this;
  }
  range(start: number, end: number): this {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }
  insert(payload: Row | Row[]): this { this.op = { kind: 'insert', payload }; return this; }
  update(payload: Row): this { this.op = { kind: 'update', payload }; return this; }
  delete(): this { this.op = { kind: 'delete' }; return this; }

  eq(col: string, val: unknown): this { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown): this {
    if (val === null) this.filters.push((r) => r[col] == null);
    else this.filters.push((r) => r[col] === val);
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push((r) => {
      const cell = r[col];
      if (cell == null || val == null) return false;
      if (typeof cell === 'string' && typeof val === 'string') {
        return new Date(cell).getTime() < new Date(val).getTime();
      }
      return (cell as number) < (val as number);
    });
    return this;
  }
  lte(col: string, val: unknown): this {
    this.filters.push((r) => {
      const cell = r[col];
      if (cell == null || val == null) return false;
      if (typeof cell === 'string' && typeof val === 'string') {
        return new Date(cell).getTime() <= new Date(val).getTime();
      }
      return (cell as number) <= (val as number);
    });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push((r) => {
      const cell = r[col];
      if (cell == null || val == null) return false;
      if (typeof cell === 'string' && typeof val === 'string') {
        return new Date(cell).getTime() >= new Date(val).getTime();
      }
      return (cell as number) >= (val as number);
    });
    return this;
  }

  single(): Promise<StubResult<unknown>> { return this.run(true, false); }
  maybeSingle(): Promise<StubResult<unknown>> { return this.run(true, true); }

  // Promise-like: terminal `await` resolves without single().
  then<TResult1 = StubResult<unknown>, TResult2 = never>(
    onFulfilled?: ((value: StubResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run(false, false).then(onFulfilled as never, onRejected as never);
  }

  private async run(single: boolean, maybe: boolean): Promise<StubResult<unknown>> {
    const rows = this.stub.tables.get(this.table) ?? [];
    if (!this.op) return { data: null, error: { message: 'no op' } };

    if (this.op.kind === 'select') {
      let matched = rows.filter((r) => this.filters.every((f) => f(r)));
      // Phase 4 — head:true returns count without rows.
      if (this.countOnly) {
        return { data: null, error: null, count: matched.length } as StubResult<unknown> & { count: number };
      }
      if (this.orderCol) {
        const col = this.orderCol;
        const asc = this.orderAsc;
        matched = [...matched].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'string' && typeof bv === 'string') {
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          }
          return asc ? ((av as number) - (bv as number)) : ((bv as number) - (av as number));
        });
      }
      if (this.rangeStart != null && this.rangeEnd != null) {
        matched = matched.slice(this.rangeStart, this.rangeEnd + 1);
      }
      if (single) {
        if (matched.length === 0) {
          return maybe ? { data: null, error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: matched[0], error: null };
      }
      return { data: matched, error: null, count: matched.length } as StubResult<unknown> & { count: number };
    }

    if (this.op.kind === 'insert') {
      const payload = Array.isArray(this.op.payload) ? (this.op.payload as Row[]) : [this.op.payload as Row];
      // Honor unique constraints declared via stub.tables metadata if present.
      if (this.table === 'upload_sessions') {
        const existing = rows.filter((r) => r.consumed_at == null);
        for (const p of payload) {
          if (existing.some((r) => r.run_id === p.run_id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint upload_sessions_one_inflight_per_run' } };
          }
        }
      }
      if (this.table === 'upload_session_chunks') {
        for (const p of payload) {
          if (rows.some((r) => r.session_id === p.session_id && r.seq === p.seq)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
          }
        }
      }
      if (this.table === 'stripe_webhook_events') {
        for (const p of payload) {
          if (rows.some((r) => r.id === p.id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint stripe_webhook_events_pkey' } };
          }
        }
        // Default columns the route reads back.
        const stamped = payload.map((p) => ({
          status: 'processing',
          attempt_count: 1,
          processing_started_at: new Date().toISOString(),
          locked_until: new Date(Date.now() + 60_000).toISOString(),
          received_at: new Date().toISOString(),
          completed_at: null,
          error: null,
          ...p,
        }));
        this.stub.tables.set(this.table, [...rows, ...stamped]);
        return { data: stamped, error: null };
      }
      if (this.table === 'billing_customers') {
        for (const p of payload) {
          if (rows.some((r) => r.organization_id === p.organization_id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint billing_customers_pkey' } };
          }
          if (rows.some((r) => r.stripe_customer_id === p.stripe_customer_id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint billing_customers_stripe_customer_id_key' } };
          }
        }
      }
      if (this.table === 'personal_entitlements') {
        for (const p of payload) {
          if (rows.some((r) => r.user_id === p.user_id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint personal_entitlements_pkey' } };
          }
        }
      }
      this.stub.tables.set(this.table, [...rows, ...payload]);
      return { data: payload, error: null };
    }

    if (this.op.kind === 'update') {
      // Test seam: simulate DB write failure on demand.
      if (this.stub.forceUpdateError.has(this.table)) {
        return { data: null, error: { message: `simulated update failure on ${this.table}` } };
      }
      const updated: Row[] = [];
      const next = rows.map((r) => {
        if (this.filters.every((f) => f(r))) {
          const merged = { ...r, ...(this.op!.payload as Row) };
          updated.push(merged);
          return merged;
        }
        return r;
      });
      this.stub.tables.set(this.table, next);
      return { data: updated, error: null };
    }

    if (this.op.kind === 'delete') {
      const next = rows.filter((r) => !this.filters.every((f) => f(r)));
      this.stub.tables.set(this.table, next);
      return { data: null, error: null };
    }

    return { data: null, error: { message: 'unknown op' } };
  }
}

export class SupabaseStub {
  tables = new Map<string, Row[]>();
  storage = new Map<string, Buffer>();
  rowLocks = new Map<string, Mutex>();   // key: `upload_sessions:${jti}`
  forceUpdateError = new Set<string>();   // tables whose UPDATE should return a synthetic error
  failSignedUrl = false;                  // when true, createSignedUrl returns an error

  reset(): void {
    this.tables.clear();
    this.storage.clear();
    this.rowLocks.clear();
    this.forceUpdateError.clear();
    this.failSignedUrl = false;
  }

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows]);
  }

  private getOrCreateLock(key: string): Mutex {
    let m = this.rowLocks.get(key);
    if (!m) { m = new Mutex(); this.rowLocks.set(key, m); }
    return m;
  }

  async withSessionLock<T>(jti: string, fn: () => Promise<T>): Promise<T> {
    return this.getOrCreateLock(`upload_sessions:${jti}`).lock(fn);
  }

  async callRpc(fn: string, args: Record<string, unknown>): Promise<StubResult<unknown>> {
    if (fn === 'claim_chunk_slot') {
      return this.withSessionLock(args.p_jti as string, async () => {
        const sessions = this.tables.get('upload_sessions') ?? [];
        const s = sessions.find((r) => r.jti === args.p_jti);
        if (!s) return { data: null, error: { code: 'P0001', message: 'session_not_found' } };
        if (s.consumed_at) return { data: null, error: { code: 'P0002', message: 'session_consumed' } };
        if (new Date(s.expires_at as string) < new Date()) return { data: null, error: { code: 'P0003', message: 'session_expired' } };
        if (s.run_id !== args.p_run_id || s.user_id !== args.p_caller_user_id) {
          return { data: null, error: { code: 'P0004', message: 'ownership_mismatch' } };
        }

        const chunks = this.tables.get('upload_session_chunks') ?? [];
        const existing = chunks.find((c) => c.session_id === s.id && c.seq === args.p_seq);
        if (existing) {
          if (existing.hash !== args.p_this_hash || existing.bytes !== args.p_bytes || existing.storage_path !== args.p_storage_path) {
            return { data: null, error: { code: 'P0005', message: 'duplicate_chunk_mismatch' } };
          }
          return { data: [{ session_id: s.id, seq: args.p_seq, hash: args.p_this_hash }], error: null };
        }

        if (args.p_seq !== s.next_expected_seq) {
          return { data: null, error: { code: 'P0006', message: 'wrong_seq' } };
        }
        if (args.p_prev_hash !== s.chain_tip_hash) {
          return { data: null, error: { code: 'P0007', message: 'wrong_prev_hash' } };
        }

        this.tables.set('upload_session_chunks', [...chunks, {
          session_id: s.id,
          seq: args.p_seq,
          hash: args.p_this_hash,
          bytes: args.p_bytes,
          storage_path: args.p_storage_path,
          status: 'pending',
        }]);
        return { data: [{ session_id: s.id, seq: args.p_seq, hash: args.p_this_hash }], error: null };
      });
    }

    if (fn === 'mark_chunk_persisted') {
      // codex PR CRITICAL — must validate jti + caller + chunk hash
      // before advancing chain state.
      return this.withSessionLock(args.p_jti as string, async () => {
        const sessions = this.tables.get('upload_sessions') ?? [];
        const s = sessions.find((r) => r.jti === args.p_jti);
        if (!s) return { data: null, error: { code: 'P0001', message: 'session_not_found' } };
        if (s.user_id !== args.p_caller_user_id) {
          return { data: null, error: { code: 'P0004', message: 'ownership_mismatch' } };
        }
        if (s.consumed_at) {
          return { data: null, error: { code: 'P0002', message: 'session_consumed' } };
        }

        const chunks = this.tables.get('upload_session_chunks') ?? [];
        const c = chunks.find((row) => row.session_id === s.id && row.seq === args.p_seq);
        if (!c) return { data: null, error: { code: 'P0008', message: 'chunk_not_found' } };
        if (c.hash !== args.p_this_hash) {
          return { data: null, error: { code: 'P0009', message: 'chunk_hash_mismatch' } };
        }

        const updatedChunks = chunks.map((row) =>
          row.session_id === s.id && row.seq === args.p_seq
            ? { ...row, status: 'persisted' }
            : row,
        );
        this.tables.set('upload_session_chunks', updatedChunks);

        if (s.next_expected_seq === args.p_seq) {
          const updated = sessions.map((r) =>
            r.id === s.id
              ? { ...r, next_expected_seq: (args.p_seq as number) + 1, chain_tip_hash: args.p_this_hash }
              : r,
          );
          this.tables.set('upload_sessions', updated);
        }
        return { data: null, error: null };
      });
    }

    if (fn === 'expire_mint_nonces') {
      const cutoff = Date.now() - 5 * 60 * 1000;
      const rows = this.tables.get('api_key_mint_nonces') ?? [];
      const keep = rows.filter((r) => new Date(r.created_at as string).getTime() >= cutoff);
      this.tables.set('api_key_mint_nonces', keep);
      return { data: rows.length - keep.length, error: null };
    }

    if (fn === 'count_runs_this_month') {
      // Phase 3 entitlement gate — count runs for the current calendar month
      // (UTC). Mirrors the SQL `date_trunc('month', NOW() AT TIME ZONE 'UTC')`.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const orgId = args.p_organization_id as string | null;
      const userId = args.p_user_id as string;
      const rows = (this.tables.get('runs') ?? []).filter((r) => {
        if (new Date(r.created_at as string) < monthStart) return false;
        if (orgId != null) return r.organization_id === orgId;
        return r.organization_id == null && r.user_id === userId;
      });
      return { data: rows.length, error: null };
    }

    if (fn === 'sum_retained_bytes') {
      // Phase 3 — sum total_bytes of non-deleted runs within retention window.
      const days = (args.p_retention_days as number | undefined) ?? 90;
      const cutoff = new Date(Date.now() - days * 86400_000);
      const orgId = args.p_organization_id as string | null;
      const userId = args.p_user_id as string;
      const rows = (this.tables.get('runs') ?? []).filter((r) => {
        if (r.deleted_at != null) return false;
        if (new Date(r.created_at as string) < cutoff) return false;
        if (orgId != null) return r.organization_id === orgId;
        return r.organization_id == null && r.user_id === userId;
      });
      const sum = rows.reduce((s, r) => s + (Number(r.total_bytes) || 0), 0);
      return { data: sum, error: null };
    }

    if (fn === 'mint_api_key_with_nonce') {
      // Phase 2.3 — atomic mint+nonce-record. Sweep stale nonces, reject
      // duplicate nonce, insert key + nonce in a single conceptual txn.
      const cutoff = Date.now() - 5 * 60 * 1000;
      const nonces = (this.tables.get('api_key_mint_nonces') ?? []).filter(
        (r) => new Date(r.created_at as string).getTime() >= cutoff,
      );
      this.tables.set('api_key_mint_nonces', nonces);

      const userId = args.p_user_id as string;
      const nonce = args.p_nonce as string;
      const dup = nonces.some((r) => r.user_id === userId && r.nonce === nonce);
      if (dup) {
        return { data: null, error: { code: 'P0010', message: 'nonce_conflict' } };
      }

      const id = `key_${Math.random().toString(36).slice(2, 10)}`;
      const keys = this.tables.get('api_keys') ?? [];
      this.tables.set('api_keys', [...keys, {
        id,
        user_id: userId,
        key_hash: args.p_key_hash,
        prefix_display: args.p_prefix_display,
        label: args.p_label ?? null,
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      }]);

      this.tables.set('api_key_mint_nonces', [...nonces, {
        user_id: userId,
        nonce,
        api_key_id: id,
        created_at: new Date().toISOString(),
      }]);

      return { data: [{ key_id: id }], error: null };
    }

    // ========================================================================
    // Phase 5.1 — members management RPCs.
    //
    // These mirror the SQL functions in
    // data/deltas/20260508140000_phase5_1_member_rpcs.sql. The stub is
    // single-threaded so the FOR UPDATE locks are implicit; concurrency
    // test (#31) relies on the test-local mutex above to prove serial
    // execution equivalent to FOR UPDATE.
    // ========================================================================

    if (fn === 'list_org_members_with_emails') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const memberships = this.tables.get('memberships') ?? [];
      const callerActive = memberships.some(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerActive) {
        return { data: null, error: { code: 'P0001', message: 'not_member' } };
      }
      const users = this.tables.get('auth.users') ?? [];
      const emailById = new Map<string, string>(
        users.map((u) => [u.id as string, u.email as string]),
      );
      const members = memberships
        .filter((m) => m.organization_id === orgId && m.status === 'active')
        .map((m) => ({
          id: m.id,
          userId: m.user_id,
          email: emailById.get(m.user_id as string) ?? null,
          role: m.role,
          status: m.status,
          joinedAt: m.joined_at,
        }));
      return { data: { members }, error: null };
    }

    if (fn === 'invite_member') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const inviteeEmail = (args.p_invitee_email as string).trim().toLowerCase();
      const role = args.p_role as string;
      if (!['member', 'admin'].includes(role)) {
        return { data: null, error: { code: 'P0001', message: 'bad_role' } };
      }
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const users = this.tables.get('auth.users') ?? [];
      const invitee = users.find((u) => (u.email as string).toLowerCase() === inviteeEmail);
      if (!invitee) {
        return { data: null, error: { code: 'P0001', message: 'user_not_found' } };
      }
      const existing = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === invitee.id,
      );
      if (existing && existing.status === 'active') {
        return { data: null, error: { code: 'P0001', message: 'already_member' } };
      }
      let membership: Row;
      let previousStatus: string | null = null;
      if (existing) {
        previousStatus = existing.status as string;
        existing.status = 'active';
        existing.role = role;
        existing.joined_at = new Date().toISOString();
        membership = existing;
      } else {
        membership = {
          id: globalThis.crypto.randomUUID(),
          organization_id: orgId,
          user_id: invitee.id,
          role,
          status: 'active',
          joined_at: new Date().toISOString(),
        };
        memberships.push(membership);
        this.tables.set('memberships', memberships);
      }
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.member.invited',
        subject_type: 'membership',
        subject_id: membership.id,
        metadata: { inviteeUserId: invitee.id, role, previousStatus },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { membership, noop: false }, error: null };
    }

    if (fn === 'change_member_role') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const targetUserId = args.p_target_user_id as string;
      const newRole = args.p_new_role as string;
      if (!['member', 'admin', 'owner'].includes(newRole)) {
        return { data: null, error: { code: 'P0001', message: 'bad_role' } };
      }
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      const callerRole = callerRow?.role as string | undefined;
      if (!callerRole) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const target = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === targetUserId && m.status === 'active',
      );
      if (!target) {
        return { data: null, error: { code: 'P0001', message: 'target_not_member' } };
      }
      if (callerRole === 'admin') {
        if (target.role === 'owner' || newRole === 'owner') {
          return { data: null, error: { code: 'P0001', message: 'role_transition' } };
        }
      } else if (callerRole !== 'owner') {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      if (target.role === 'owner' && newRole !== 'owner') {
        const ownerCount = memberships.filter(
          (m) => m.organization_id === orgId && m.role === 'owner' && m.status === 'active',
        ).length;
        if (ownerCount <= 1) {
          return { data: null, error: { code: 'P0001', message: 'last_owner' } };
        }
      }
      if (target.role === newRole) {
        return { data: { membership: { ...target }, noop: true }, error: null };
      }
      const oldRole = target.role as string;
      target.role = newRole;
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.member.role_changed',
        subject_type: 'membership',
        subject_id: target.id,
        metadata: { targetUserId, oldRole, newRole },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { membership: { ...target }, noop: false }, error: null };
    }

    if (fn === 'remove_member') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const targetUserId = args.p_target_user_id as string;
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      const callerRole = callerRow?.role as string | undefined;
      if (!callerRole || !['admin', 'owner'].includes(callerRole)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const target = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === targetUserId && m.status === 'active',
      );
      if (!target) {
        return { data: null, error: { code: 'P0001', message: 'target_not_member' } };
      }
      if (callerRole === 'admin' && target.role !== 'member') {
        return { data: null, error: { code: 'P0001', message: 'not_owner' } };
      }
      if (target.role === 'owner') {
        const ownerCount = memberships.filter(
          (m) => m.organization_id === orgId && m.role === 'owner' && m.status === 'active',
        ).length;
        if (ownerCount <= 1) {
          return { data: null, error: { code: 'P0001', message: 'last_owner' } };
        }
      }
      const previousRole = target.role as string;
      target.status = 'removed';
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.member.removed',
        subject_type: 'membership',
        subject_id: target.id,
        metadata: { targetUserId, previousRole },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { membership: { ...target }, noop: false }, error: null };
    }

    if (fn === 'update_org_name') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const newName = String(args.p_new_name ?? '').trim();
      if (newName.length < 1 || newName.length > 100) {
        return { data: null, error: { code: 'P0001', message: 'bad_name' } };
      }
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      const callerRole = callerRow?.role as string | undefined;
      if (!callerRole || callerRole !== 'owner') {
        return { data: null, error: { code: 'P0001', message: 'not_owner' } };
      }
      const orgs = this.tables.get('organizations') ?? [];
      const org = orgs.find((o) => o.id === orgId);
      // Codex PR-pass WARNING — explicit org existence check, mirrors SQL.
      if (!org) {
        return { data: null, error: { code: 'P0001', message: 'org_not_found' } };
      }
      const oldName = org.name as string | undefined ?? null;
      org.name = newName;
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.settings.updated',
        subject_type: 'organization',
        subject_id: orgId,
        metadata: { field: 'name', oldValue: oldName, newValue: newName },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { organization: { ...org }, noop: false }, error: null };
    }

    // ========================================================================
    // Phase 5.2 — audit log + cost report read RPCs.
    // ========================================================================

    if (fn === 'list_audit_events') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const cursorOccurredAt = args.p_cursor_occurred_at as string | null;
      const cursorId = args.p_cursor_id as number | null;
      const limit = Math.min(Math.max(Number(args.p_limit ?? 50), 1), 200);
      const filterAction = args.p_action as string | null;
      const filterActor = args.p_actor_user_id as string | null;
      const since = args.p_since as string | null;
      const until = args.p_until as string | null;

      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }

      const events = (this.tables.get('audit_events') ?? [])
        .filter((e) => e.organization_id === orgId)
        .filter((e) => {
          if (!cursorOccurredAt || cursorId == null) return true;
          const cmp = new Date(e.occurred_at as string).getTime() - new Date(cursorOccurredAt).getTime();
          if (cmp !== 0) return cmp < 0;
          return Number(e.id) < cursorId;
        })
        .filter((e) => filterAction == null || e.action === filterAction)
        .filter((e) => filterActor == null || e.actor_user_id === filterActor)
        .filter((e) => since == null || new Date(e.occurred_at as string) >= new Date(since))
        .filter((e) => until == null || new Date(e.occurred_at as string) < new Date(until))
        .sort((a, b) => {
          const t = new Date(b.occurred_at as string).getTime() - new Date(a.occurred_at as string).getTime();
          if (t !== 0) return t;
          return Number(b.id) - Number(a.id);
        });

      const users = this.tables.get('auth.users') ?? [];
      const emailById = new Map<string, string>(users.map((u) => [u.id as string, u.email as string]));
      const page = events.slice(0, limit);
      const hasNext = events.length > limit;
      const lastOnPage = page[page.length - 1];

      const eventsJson = page.map((e) => ({
        id: e.id,
        action: e.action,
        actorUserId: e.actor_user_id ?? null,
        actorEmail: e.actor_user_id ? (emailById.get(e.actor_user_id as string) ?? null) : null,
        subjectType: e.subject_type,
        subjectId: e.subject_id,
        metadata: e.metadata ?? {},
        occurredAt: e.occurred_at,
        prevHash: e.prev_hash ?? null,
        thisHash: e.this_hash ?? null,
      }));

      const nextCursor = hasNext && lastOnPage
        ? { occurredAt: lastOnPage.occurred_at, id: lastOnPage.id }
        : null;
      return { data: { events: eventsJson, nextCursor }, error: null };
    }

    if (fn === 'org_cost_report') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const since = args.p_since as string;
      const until = args.p_until as string;
      const groupBy = args.p_group_by as string;

      // Codex PR-pass WARNING — authorize first.
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      if (groupBy !== 'user') {
        return { data: null, error: { code: 'P0001', message: 'bad_group_by' } };
      }

      const sinceTs = new Date(since).getTime();
      const untilTs = new Date(until).getTime();
      const filtered = (this.tables.get('runs') ?? []).filter((r) => {
        if (r.organization_id !== orgId) return false;
        if (r.deleted_at != null) return false;
        const t = new Date(r.created_at as string).getTime();
        return t >= sinceTs && t < untilTs;
      });

      const byUser = new Map<string, {
        user_id: string; run_count: number; cost_usd_sum: number;
        duration_ms_sum: number; total_bytes_sum: number; last_run_at: string | null;
      }>();
      for (const r of filtered) {
        const uid = r.user_id as string;
        const cur = byUser.get(uid) ?? {
          user_id: uid, run_count: 0, cost_usd_sum: 0,
          duration_ms_sum: 0, total_bytes_sum: 0, last_run_at: null,
        };
        cur.run_count += 1;
        cur.cost_usd_sum += Number(r.cost_usd ?? 0);
        cur.duration_ms_sum += Number(r.duration_ms ?? 0);
        cur.total_bytes_sum += Number(r.total_bytes ?? 0);
        const t = r.created_at as string;
        if (!cur.last_run_at || new Date(t) > new Date(cur.last_run_at)) cur.last_run_at = t;
        byUser.set(uid, cur);
      }
      const users = this.tables.get('auth.users') ?? [];
      const emailById = new Map<string, string>(users.map((u) => [u.id as string, u.email as string]));
      const rows = Array.from(byUser.values())
        .sort((a, b) => b.cost_usd_sum - a.cost_usd_sum || a.user_id.localeCompare(b.user_id))
        .map((a) => ({
          user_id: a.user_id,
          email: emailById.get(a.user_id) ?? null,
          run_count: a.run_count,
          cost_usd_sum: a.cost_usd_sum,
          duration_ms_sum: a.duration_ms_sum,
          total_bytes_sum: a.total_bytes_sum,
          last_run_at: a.last_run_at,
        }));
      const total = {
        run_count: rows.reduce((s, r) => s + r.run_count, 0),
        cost_usd_sum: rows.reduce((s, r) => s + r.cost_usd_sum, 0),
        duration_ms_sum: rows.reduce((s, r) => s + r.duration_ms_sum, 0),
        total_bytes_sum: rows.reduce((s, r) => s + r.total_bytes_sum, 0),
      };
      return { data: { rows, total, period: { since, until } }, error: null };
    }

    // ========================================================================
    // Phase 5.4 — WorkOS SSO setup RPCs.
    //
    // Mirror data/deltas/20260508180000_phase5_4_workos_setup.sql.
    // ========================================================================

    if (fn === 'record_sso_setup_initiated') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const workosOrgId = (args.p_workos_organization_id as string | null)?.trim() ?? '';
      if (!workosOrgId) {
        return { data: null, error: { code: 'P0001', message: 'bad_workos_org_id' } };
      }
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const settings = this.tables.get('organization_settings') ?? [];
      const existing = settings.find((s) => s.organization_id === orgId);
      const existingWorkosOrg = existing?.workos_organization_id as string | null | undefined;
      const existingStatus = existing?.sso_connection_status as string | null | undefined;
      if (
        existingWorkosOrg
        && existingWorkosOrg !== workosOrgId
        && existingStatus === 'active'
      ) {
        return { data: null, error: { code: 'P0001', message: 'workos_org_already_bound' } };
      }
      const newStatus = existingStatus === 'active' ? 'active' : 'pending';
      if (existing) {
        existing.workos_organization_id = workosOrgId;
        existing.sso_connection_status = newStatus;
        existing.updated_at = new Date().toISOString();
        existing.updated_by = callerUserId;
      } else {
        settings.push({
          organization_id: orgId,
          workos_organization_id: workosOrgId,
          sso_connection_status: newStatus,
          updated_at: new Date().toISOString(),
          updated_by: callerUserId,
        });
        this.tables.set('organization_settings', settings);
      }
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.setup_initiated',
        subject_type: 'organization',
        subject_id: orgId,
        metadata: {
          workosOrganizationId: workosOrgId,
          previousStatus: existingStatus ?? 'inactive',
          newStatus,
        },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return {
        data: {
          organizationId: orgId,
          workosOrganizationId: workosOrgId,
          status: newStatus,
        },
        error: null,
      };
    }

    if (fn === 'disable_sso_connection') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || callerRow.role !== 'owner') {
        return { data: null, error: { code: 'P0001', message: 'not_owner' } };
      }
      const settings = this.tables.get('organization_settings') ?? [];
      const existing = settings.find((s) => s.organization_id === orgId);
      const existingStatus = existing?.sso_connection_status as string | null | undefined;
      const existingConnId = (existing?.workos_connection_id as string | null | undefined) ?? null;
      if (!existingStatus || ['inactive', 'disabled'].includes(existingStatus)) {
        return {
          data: {
            organizationId: orgId,
            status: existingStatus ?? 'inactive',
            workosConnectionId: existingConnId,
            noop: true,
          },
          error: null,
        };
      }
      existing!.sso_connection_status = 'disabled';
      existing!.sso_disabled_at = new Date().toISOString();
      existing!.updated_at = new Date().toISOString();
      existing!.updated_by = callerUserId;
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.disabled',
        subject_type: 'organization',
        subject_id: orgId,
        metadata: { previousStatus: existingStatus, workosConnectionId: existingConnId },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return {
        data: {
          organizationId: orgId,
          status: 'disabled',
          workosConnectionId: existingConnId,
          noop: false,
        },
        error: null,
      };
    }

    if (fn === 'apply_workos_event') {
      const eventId = args.p_event_id as string;
      const eventType = args.p_event_type as string;
      const workosOrgId = args.p_workos_organization_id as string;
      const workosConnId = args.p_workos_connection_id as string | null;
      const eventOccurredAt = args.p_event_occurred_at as string;
      const payloadHash = args.p_payload_hash as string;
      const lockSeconds = Math.max(Number(args.p_lock_seconds ?? 60), 10);

      const events = this.tables.get('processed_workos_events') ?? [];
      const existing = events.find((e) => e.event_id === eventId);
      const now = new Date();

      // Step 1: claim/recover.
      if (!existing) {
        events.push({
          event_id: eventId,
          event_type: eventType,
          payload_hash: payloadHash,
          status: 'processing',
          processing_started_at: now.toISOString(),
          locked_until: new Date(now.getTime() + lockSeconds * 1000).toISOString(),
          attempt_count: 1,
          organization_id: null,
          last_error: null,
          processed_at: null,
          created_at: now.toISOString(),
        });
        this.tables.set('processed_workos_events', events);
      } else if (existing.status === 'processed') {
        return { data: { result: 'duplicate', eventId }, error: null };
      } else if (
        existing.status === 'processing'
        && existing.locked_until
        && new Date(existing.locked_until as string).getTime() > now.getTime()
      ) {
        return { data: { result: 'in_flight', eventId }, error: null };
      } else {
        existing.status = 'processing';
        existing.processing_started_at = now.toISOString();
        existing.locked_until = new Date(now.getTime() + lockSeconds * 1000).toISOString();
        existing.attempt_count = Number(existing.attempt_count ?? 0) + 1;
        existing.last_error = null;
      }

      const eventRow = events.find((e) => e.event_id === eventId)!;

      // Step 2: resolve org.
      const settings = this.tables.get('organization_settings') ?? [];
      const settingsRow = settings.find((s) => s.workos_organization_id === workosOrgId);
      if (!settingsRow) {
        eventRow.status = 'failed';
        eventRow.organization_id = null;
        eventRow.last_error = 'unknown_workos_organization';
        eventRow.locked_until = null;
        return {
          data: { result: 'unknown_org', eventId, workosOrganizationId: workosOrgId },
          error: null,
        };
      }
      eventRow.organization_id = settingsRow.organization_id;

      // Step 3: lifecycle ordering.
      const lastEventAt = settingsRow.sso_last_workos_event_at as string | null | undefined;
      const isDelete = ['connection.deleted', 'dsync.connection.deleted'].includes(eventType);
      if (lastEventAt && new Date(eventOccurredAt) <= new Date(lastEventAt) && !isDelete) {
        eventRow.status = 'processed';
        eventRow.processed_at = now.toISOString();
        eventRow.last_error = 'stale_event';
        return {
          data: { result: 'stale_event', eventId, organizationId: settingsRow.organization_id },
          error: null,
        };
      }

      // Step 4: state transition.
      const previousStatus = (settingsRow.sso_connection_status as string | null | undefined) ?? 'inactive';
      let newStatus = previousStatus;
      if (['connection.activated', 'dsync.connection.activated'].includes(eventType)) {
        newStatus = 'active';
        settingsRow.sso_connected_at = now.toISOString();
        if (workosConnId) settingsRow.workos_connection_id = workosConnId;
      } else if (['connection.deactivated', 'dsync.connection.deactivated'].includes(eventType)) {
        newStatus = 'disabled';
        settingsRow.sso_disabled_at = now.toISOString();
      } else if (isDelete) {
        newStatus = 'disabled';
        settingsRow.sso_disabled_at = now.toISOString();
        settingsRow.workos_connection_id = null;
      } else {
        eventRow.status = 'processed';
        eventRow.processed_at = now.toISOString();
        eventRow.last_error = 'unhandled_event_type';
        return {
          data: { result: 'unhandled_type', eventId, eventType },
          error: null,
        };
      }
      settingsRow.sso_connection_status = newStatus;
      settingsRow.sso_last_workos_event_at = eventOccurredAt;
      settingsRow.sso_last_workos_event_id = eventId;
      settingsRow.updated_at = now.toISOString();

      // Step 5: audit.
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: settingsRow.organization_id,
        actor_user_id: null,
        action: 'org.sso.lifecycle',
        subject_type: 'organization',
        subject_id: settingsRow.organization_id,
        metadata: {
          eventId,
          eventType,
          workosOrganizationId: workosOrgId,
          workosConnectionId: workosConnId,
          previousStatus,
          newStatus,
          occurredAt: eventOccurredAt,
        },
        created_at: now.toISOString(),
      });
      this.tables.set('audit_events', audits);

      // Step 6: complete.
      eventRow.status = 'processed';
      eventRow.processed_at = now.toISOString();
      eventRow.locked_until = null;
      eventRow.last_error = null;

      return {
        data: {
          result: 'applied',
          eventId,
          organizationId: settingsRow.organization_id,
          previousStatus,
          newStatus,
        },
        error: null,
      };
    }

    // ========================================================================
    // Phase 5.6 — WorkOS SSO sign-in RPCs.
    //
    // Mirror data/deltas/20260509120000_phase5_6_workos_signin.sql.
    // ========================================================================

    if (fn === 'claim_domain') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const domain = (args.p_normalized_domain as string).trim();
      const challenge = args.p_challenge_token as string;
      if (!domain) return { data: null, error: { code: 'P0001', message: 'invalid_domain' } };
      if (!challenge || challenge.length < 32) {
        return { data: null, error: { code: 'P0001', message: 'invalid_challenge_token' } };
      }
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const claims = this.tables.get('organization_domain_claims') ?? [];
      const otherOwned = claims.find(
        (c) => (c.domain as string).toLowerCase() === domain.toLowerCase()
          && c.ever_verified === true
          && c.organization_id !== orgId,
      );
      if (otherOwned) {
        return { data: null, error: { code: 'P0001', message: 'domain_already_claimed' } };
      }
      const samePending = claims.find(
        (c) => (c.domain as string).toLowerCase() === domain.toLowerCase()
          && c.organization_id === orgId
          && c.status === 'pending',
      );
      if (samePending) {
        return { data: null, error: { code: 'P0001', message: 'domain_already_pending' } };
      }
      const row: Row = {
        id: globalThis.crypto.randomUUID(),
        organization_id: orgId,
        domain,
        status: 'pending',
        ever_verified: false,
        challenge_token: challenge,
        verified_at: null,
        revoked_at: null,
        created_by: callerUserId,
        created_at: new Date().toISOString(),
      };
      claims.push(row);
      this.tables.set('organization_domain_claims', claims);
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.domain.claim_started',
        subject_type: 'organization_domain_claim',
        subject_id: row.id,
        metadata: { domain },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return {
        data: { id: row.id, domain, status: 'pending', challengeToken: challenge },
        error: null,
      };
    }

    if (fn === 'mark_domain_verified') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const domainId = args.p_domain_id as string;
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const claims = this.tables.get('organization_domain_claims') ?? [];
      const claim = claims.find((c) => c.id === domainId && c.organization_id === orgId);
      if (!claim) return { data: null, error: { code: 'P0001', message: 'domain_not_found' } };
      if (claim.status === 'verified') {
        return { data: { id: claim.id, status: 'verified', noop: true }, error: null };
      }
      if (claim.status === 'revoked') {
        return { data: null, error: { code: 'P0001', message: 'domain_revoked' } };
      }
      // Concurrent-verify race: check if any other claim has ever_verified for same lower(domain).
      const conflict = claims.find(
        (c) => c.id !== claim.id
          && (c.domain as string).toLowerCase() === (claim.domain as string).toLowerCase()
          && c.ever_verified === true,
      );
      if (conflict) {
        return { data: null, error: { code: 'P0001', message: 'domain_already_claimed' } };
      }
      claim.status = 'verified';
      claim.ever_verified = true;
      claim.verified_at = new Date().toISOString();
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.domain.verified',
        subject_type: 'organization_domain_claim',
        subject_id: claim.id,
        metadata: { domain: claim.domain },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { id: claim.id, status: 'verified', noop: false }, error: null };
    }

    if (fn === 'revoke_domain_claim') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const domainId = args.p_domain_id as string;
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || !['admin', 'owner'].includes(callerRow.role as string)) {
        return { data: null, error: { code: 'P0001', message: 'not_admin' } };
      }
      const claims = this.tables.get('organization_domain_claims') ?? [];
      const claim = claims.find((c) => c.id === domainId && c.organization_id === orgId);
      if (!claim) return { data: null, error: { code: 'P0001', message: 'domain_not_found' } };
      if (claim.status === 'revoked') {
        return { data: { id: claim.id, status: 'revoked', noop: true }, error: null };
      }
      claim.status = 'revoked';
      claim.revoked_at = new Date().toISOString();
      // ever_verified intentionally preserved (codex pass-1 CRITICAL #1).
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.domain.revoked',
        subject_type: 'organization_domain_claim',
        subject_id: claim.id,
        metadata: { domain: claim.domain },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { id: claim.id, status: 'revoked', noop: false }, error: null };
    }

    if (fn === 'set_sso_required') {
      const callerUserId = args.p_caller_user_id as string;
      const orgId = args.p_org_id as string;
      const required = args.p_required as boolean;
      const memberships = this.tables.get('memberships') ?? [];
      const callerRow = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === callerUserId && m.status === 'active',
      );
      if (!callerRow || callerRow.role !== 'owner') {
        return { data: null, error: { code: 'P0001', message: 'not_owner' } };
      }
      const settings = this.tables.get('organization_settings') ?? [];
      const existing = settings.find((s) => s.organization_id === orgId);
      const currentStatus = (existing?.sso_connection_status as string | undefined) ?? 'inactive';
      // Asymmetric guard.
      if (required === true && currentStatus !== 'active') {
        return { data: null, error: { code: 'P0001', message: 'no_active_sso' } };
      }
      const previous = (existing?.sso_required as boolean | undefined) ?? false;
      if (existing) {
        existing.sso_required = required;
        existing.updated_at = new Date().toISOString();
        existing.updated_by = callerUserId;
      } else {
        settings.push({
          organization_id: orgId,
          sso_required: required,
          updated_at: new Date().toISOString(),
          updated_by: callerUserId,
        });
        this.tables.set('organization_settings', settings);
      }
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: callerUserId,
        action: 'org.sso.required.toggled',
        subject_type: 'organization',
        subject_id: orgId,
        metadata: { previous, new: required },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: { organizationId: orgId, ssoRequired: required }, error: null };
    }

    if (fn === 'consume_sso_authentication_state') {
      const stateId = args.p_state_id as string;
      const nonceHash = args.p_nonce_hash as string;
      const wosOrg = args.p_workos_organization_id as string;
      const wosConn = args.p_workos_connection_id as string;
      const states = this.tables.get('sso_authentication_states') ?? [];
      const row = states.find((s) => s.id === stateId);
      if (!row) return { data: null, error: { code: 'P0001', message: 'state_not_found' } };
      if (row.consumed_at) return { data: null, error: { code: 'P0001', message: 'state_already_consumed' } };
      const expiresAt = new Date(row.expires_at as string).getTime();
      if (Date.now() > expiresAt) {
        return { data: null, error: { code: 'P0001', message: 'state_expired' } };
      }
      // Atomic consume.
      row.consumed_at = new Date().toISOString();
      if (row.nonce !== nonceHash) {
        return { data: null, error: { code: 'P0001', message: 'state_nonce_mismatch' } };
      }
      if (row.workos_organization_id !== wosOrg) {
        return { data: null, error: { code: 'P0001', message: 'state_workos_org_mismatch' } };
      }
      if (row.workos_connection_id !== wosConn) {
        return { data: null, error: { code: 'P0001', message: 'state_workos_connection_mismatch' } };
      }
      return {
        data: {
          stateId,
          organizationId: row.organization_id,
          initiatedEmail: row.initiated_email ?? null,
        },
        error: null,
      };
    }

    if (fn === 'record_workos_sign_in') {
      const orgId = args.p_organization_id as string;
      const email = args.p_email as string;
      const normalizedDomain = args.p_normalized_email_domain as string;
      const wosUserId = args.p_workos_user_id as string;
      const wosOrgId = args.p_workos_organization_id as string;
      const wosConnId = args.p_workos_connection_id as string;
      if (!email || !normalizedDomain) {
        return { data: null, error: { code: 'P0001', message: 'invalid_email' } };
      }
      // Verified domain check.
      const claims = this.tables.get('organization_domain_claims') ?? [];
      const verifiedClaim = claims.find(
        (c) => c.organization_id === orgId
          && (c.domain as string).toLowerCase() === normalizedDomain.toLowerCase()
          && c.status === 'verified',
      );
      if (!verifiedClaim) {
        return { data: null, error: { code: 'P0001', message: 'email_domain_not_claimed_for_org' } };
      }
      // Workos org binding.
      const settings = this.tables.get('organization_settings') ?? [];
      const settingsRow = settings.find((s) => s.organization_id === orgId);
      if (!settingsRow || settingsRow.workos_organization_id !== wosOrgId) {
        return { data: null, error: { code: 'P0001', message: 'unknown_org' } };
      }
      // Identity-link path.
      const identities = this.tables.get('workos_user_identities') ?? [];
      const link = identities.find(
        (i) => i.workos_user_id === wosUserId && i.workos_organization_id === wosOrgId,
      );
      let userId: string | null = null;
      let identityCreated = false;
      if (link) {
        userId = link.user_id as string;
      } else {
        const users = this.tables.get('auth.users') ?? [];
        const u = users.find((x) => (x.email as string).toLowerCase() === email.toLowerCase());
        if (!u) {
          return {
            data: { result: 'user_not_provisioned', email, organizationId: orgId },
            error: null,
          };
        }
        userId = u.id as string;
        identities.push({
          id: globalThis.crypto.randomUUID(),
          user_id: userId,
          workos_user_id: wosUserId,
          workos_organization_id: wosOrgId,
          workos_connection_id: wosConnId,
          email_at_link: email.toLowerCase(),
          created_at: new Date().toISOString(),
        });
        this.tables.set('workos_user_identities', identities);
        identityCreated = true;
      }
      const memberships = this.tables.get('memberships') ?? [];
      let membershipCreated = false;
      const existingMembership = memberships.find(
        (m) => m.organization_id === orgId && m.user_id === userId && m.status === 'active',
      );
      if (!existingMembership) {
        memberships.push({
          id: globalThis.crypto.randomUUID(),
          organization_id: orgId,
          user_id: userId,
          role: 'member',
          status: 'active',
          joined_at: new Date().toISOString(),
        });
        this.tables.set('memberships', memberships);
        membershipCreated = true;
      }
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: orgId,
        actor_user_id: userId,
        action: 'org.sso.user.signed_in',
        subject_type: 'user',
        subject_id: userId,
        metadata: {
          email,
          workosUserId: wosUserId,
          workosOrganizationId: wosOrgId,
          membershipCreated,
          identityCreated,
        },
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return {
        data: { result: 'linked', userId, membershipCreated, identityCreated },
        error: null,
      };
    }

    if (fn === 'audit_append') {
      const audits = this.tables.get('audit_events') ?? [];
      audits.push({
        organization_id: args.p_organization_id,
        actor_user_id: args.p_actor_user_id ?? null,
        action: args.p_action,
        subject_type: args.p_subject_type,
        subject_id: args.p_subject_id,
        metadata: args.p_metadata,
        created_at: new Date().toISOString(),
      });
      this.tables.set('audit_events', audits);
      return { data: 1, error: null };
    }

    return { data: null, error: { message: `unknown rpc: ${fn}` } };
  }

  asClient() {
    const stub = this;
    return {
      from(table: string): TableQuery {
        return new TableQuery(stub, table);
      },
      rpc(fn: string, args: Record<string, unknown>): Promise<StubResult<unknown>> {
        return stub.callRpc(fn, args);
      },
      auth: {
        admin: {
          async getUserById(userId: string) {
            const users = stub.tables.get('auth.users') ?? [];
            const u = users.find((x) => x.id === userId);
            if (!u) return { data: null, error: { message: 'user not found', status: 404 } };
            return { data: { user: { id: u.id, email: u.email } }, error: null };
          },
          async createUser(payload: { email: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
            const users = stub.tables.get('auth.users') ?? [];
            const existing = users.find((u) => (u.email as string).toLowerCase() === payload.email.toLowerCase());
            if (existing) {
              return { data: null, error: { message: 'User already exists', status: 422 } };
            }
            const id = globalThis.crypto.randomUUID();
            users.push({
              id,
              email: payload.email,
              user_metadata: payload.user_metadata ?? {},
              email_confirmed_at: payload.email_confirm ? new Date().toISOString() : null,
            });
            stub.tables.set('auth.users', users);
            return { data: { user: { id, email: payload.email } }, error: null };
          },
          async generateLink(payload: { type: string; email: string }) {
            const users = stub.tables.get('auth.users') ?? [];
            const u = users.find((x) => (x.email as string).toLowerCase() === payload.email.toLowerCase());
            if (!u) return { data: null, error: { message: 'user not found' } };
            // Encode user id into the hashed_token so verifyOtp can look it up.
            const hashed_token = `stub-magiclink-${u.id}`;
            return {
              data: {
                user: { id: u.id, email: u.email },
                properties: { hashed_token, action_link: `https://stub/?token=${hashed_token}` },
              },
              error: null,
            };
          },
          async signOut(_token: string, _scope: string) {
            return { error: null };
          },
        },
        async verifyOtp(payload: { token_hash: string; type: string }) {
          const id = payload.token_hash.replace(/^stub-magiclink-/, '');
          const users = stub.tables.get('auth.users') ?? [];
          const u = users.find((x) => x.id === id);
          if (!u) return { data: null, error: { message: 'invalid token' } };
          return {
            data: {
              user: { id: u.id, email: u.email },
              session: {
                access_token: `at-${id}`,
                refresh_token: `rt-${id}`,
                expires_in: 3600,
              },
            },
            error: null,
          };
        },
      },
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, body: Buffer | ArrayBuffer | Uint8Array, opts: { upsert?: boolean; contentType?: string } = {}) {
              if (!opts.upsert && stub.storage.has(path)) {
                return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
              }
              const buf = body instanceof Buffer ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);
              stub.storage.set(path, buf);
              return { data: { path }, error: null };
            },
            async download(path: string) {
              const buf = stub.storage.get(path);
              if (!buf) return { data: null, error: { message: 'Not found' } };
              // Wrap the Buffer in a Blob-like object with arrayBuffer().
              // jsdom's Blob lacks a working arrayBuffer() in some versions,
              // so we hand back a duck-typed object that callers treat as
              // a Blob.
              const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
              const blobLike = {
                size: buf.byteLength,
                type: 'application/octet-stream',
                arrayBuffer: async () => ab,
              };
              return { data: blobLike, error: null };
            },
            // Phase 4 — signed URL minter for the artifact route.
            async createSignedUrl(path: string, ttlSeconds: number) {
              if (stub.failSignedUrl) {
                return { data: null, error: { message: 'simulated signed-url failure' } };
              }
              const signed = `https://stub.example/storage/v1/object/sign/${bucket}/${encodeURIComponent(path)}?token=test&ttl=${ttlSeconds}`;
              return { data: { signedUrl: signed }, error: null };
            },
          };
        },
      },
    };
  }
}

// Singleton stub. Tests call stub.reset() in beforeEach.
// Top-level vi.mock(...) in each test file references this singleton.
export const stub = new SupabaseStub();

// Wire the test transaction hook so finalize serializes on the same jti
// mutex used by RPC calls. This matches the prod ordering invariant
// (single critical section per session).
_setTransactionHookForTests((jti, fn) => stub.withSessionLock(jti, fn));
