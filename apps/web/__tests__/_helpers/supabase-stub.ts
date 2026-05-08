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
      const oldName = org?.name as string | undefined ?? null;
      if (org) {
        org.name = newName;
      } else {
        orgs.push({ id: orgId, name: newName });
        this.tables.set('organizations', orgs);
      }
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
