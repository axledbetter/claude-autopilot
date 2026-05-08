'use client';

// Audit table — Phase 5.2.

import { useState } from 'react';
import AuditFilterBar from './AuditFilterBar';

export interface AuditEventRow {
  id: number;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  prevHash: string | null;
  thisHash: string | null;
}

interface Props {
  orgId: string;
  initialEvents: AuditEventRow[];
  initialNextCursor: string | null;
}

export default function AuditTable({ orgId, initialEvents, initialNextCursor }: Props): React.ReactElement {
  const [events, setEvents] = useState<AuditEventRow[]>(initialEvents);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [filterAction, setFilterAction] = useState<string>('');

  async function refresh(action: string): Promise<void> {
    setLoading(true);
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    const r = await fetch(`/api/dashboard/orgs/${orgId}/audit?${params.toString()}`, { credentials: 'include' });
    setLoading(false);
    if (!r.ok) return;
    const body = await r.json() as { events: AuditEventRow[]; nextCursor: string | null };
    setEvents(body.events);
    setNextCursor(body.nextCursor);
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoading(true);
    const params = new URLSearchParams({ cursor: nextCursor });
    if (filterAction) params.set('action', filterAction);
    const r = await fetch(`/api/dashboard/orgs/${orgId}/audit?${params.toString()}`, { credentials: 'include' });
    setLoading(false);
    if (!r.ok) return;
    const body = await r.json() as { events: AuditEventRow[]; nextCursor: string | null };
    setEvents([...events, ...body.events]);
    setNextCursor(body.nextCursor);
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <AuditFilterBar
        action={filterAction}
        onActionChange={(a) => { setFilterAction(a); void refresh(a); }}
      />
      <div className="border border-white/10 rounded">
        <div className="grid grid-cols-[2fr_2fr_2fr_1fr] gap-4 px-4 py-2 border-b border-white/10 text-xs opacity-50 uppercase">
          <span>Action</span><span>Actor</span><span>Subject</span><span>When</span>
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-center opacity-60 text-sm">No audit events.</div>
        ) : events.map((e) => (
          <div key={e.id} className="grid grid-cols-[2fr_2fr_2fr_1fr] gap-4 px-4 py-2 border-b border-white/5 items-start text-sm">
            <span className="font-mono text-xs">{e.action}</span>
            <span className="text-xs opacity-80">{e.actorEmail ?? <code className="opacity-60">deleted user</code>}</span>
            <span className="text-xs opacity-80">{e.subjectType}/{e.subjectId.slice(0, 12)}…</span>
            <span className="text-xs opacity-60">{new Date(e.occurredAt).toLocaleString()}</span>
          </div>
        ))}
      </div>
      {nextCursor && (
        <button
          type="button"
          onClick={() => { void loadMore(); }}
          disabled={loading}
          className="self-start text-sm underline opacity-70 hover:opacity-100 disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
