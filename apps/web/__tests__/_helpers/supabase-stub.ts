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

  constructor(private stub: SupabaseStub, private table: string) {}

  select(_cols = '*'): this { this.op = { kind: 'select' }; return this; }
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
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      if (single) {
        if (matched.length === 0) {
          return maybe ? { data: null, error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: matched[0], error: null };
      }
      return { data: matched, error: null };
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
      this.stub.tables.set(this.table, [...rows, ...payload]);
      return { data: payload, error: null };
    }

    if (this.op.kind === 'update') {
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

  reset(): void {
    this.tables.clear();
    this.storage.clear();
    this.rowLocks.clear();
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
      const sessions = this.tables.get('upload_sessions') ?? [];
      const s = sessions.find((r) => r.id === args.p_session_id);
      if (!s) return { data: null, error: { message: 'session_not_found' } };

      return this.withSessionLock(s.jti as string, async () => {
        const chunks = (this.tables.get('upload_session_chunks') ?? []).map((c) => {
          if (c.session_id === args.p_session_id && c.seq === args.p_seq) {
            return { ...c, status: 'persisted' };
          }
          return c;
        });
        this.tables.set('upload_session_chunks', chunks);

        const sessionsCurrent = this.tables.get('upload_sessions') ?? [];
        const sCurrent = sessionsCurrent.find((r) => r.id === args.p_session_id);
        if (sCurrent && sCurrent.next_expected_seq === args.p_seq) {
          const updated = sessionsCurrent.map((r) =>
            r.id === args.p_session_id
              ? { ...r, next_expected_seq: (args.p_seq as number) + 1, chain_tip_hash: args.p_this_hash }
              : r,
          );
          this.tables.set('upload_sessions', updated);
        }
        return { data: null, error: null };
      });
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
        from(_bucket: string) {
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
              const blob = new Blob([new Uint8Array(buf)]);
              return { data: blob, error: null };
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
