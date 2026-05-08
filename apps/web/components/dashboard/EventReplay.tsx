'use client';

// Event replay — Phase 4 client component. Manifest-driven; lazy chunks.
//
// Fetches /api/dashboard/runs/:runId/artifact?kind=manifest first, then
// chunks lazily. Hard cap 1000 events across all loaded chunks for MVP.

import { useState } from 'react';

interface ChunkInfo { seq: number; hash: string; bytes: number }
interface Manifest { version: number; runId: string; chainRoot: string; totalBytes: number; chunks: ChunkInfo[] }

const MAX_EVENTS = 1000;

interface Props { runId: string }

export default function EventReplay({ runId }: Props): React.ReactElement {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [events, setEvents] = useState<unknown[]>([]);
  const [loadedChunks, setLoadedChunks] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ensureManifest(): Promise<Manifest | null> {
    if (manifest) return manifest;
    setBusy(true);
    setErr(null);
    try {
      const minted = await fetch(`/api/dashboard/runs/${runId}/artifact?kind=manifest`, { credentials: 'include' });
      if (!minted.ok) {
        setErr(`manifest mint failed (${minted.status})`);
        return null;
      }
      const { url } = await minted.json() as { url: string };
      const res = await fetch(url);
      if (!res.ok) {
        setErr(`manifest fetch failed (${res.status})`);
        return null;
      }
      const m = await res.json() as Manifest;
      setManifest(m);
      return m;
    } finally {
      setBusy(false);
    }
  }

  async function loadNextChunk(): Promise<void> {
    const m = await ensureManifest();
    if (!m) return;
    if (loadedChunks >= m.chunks.length) return;
    if (events.length >= MAX_EVENTS) return;
    setBusy(true);
    setErr(null);
    try {
      const seq = loadedChunks;
      const minted = await fetch(`/api/dashboard/runs/${runId}/artifact?kind=chunk&seq=${seq}`, { credentials: 'include' });
      if (!minted.ok) {
        setErr(`chunk mint failed (${minted.status})`);
        return;
      }
      const { url } = await minted.json() as { url: string };
      const res = await fetch(url);
      if (!res.ok) {
        setErr(`chunk fetch failed (${res.status})`);
        return;
      }
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      const parsed: unknown[] = [];
      for (const line of lines) {
        if (events.length + parsed.length >= MAX_EVENTS) break;
        try { parsed.push(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
      setEvents([...events, ...parsed]);
      setLoadedChunks(seq + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-white/10 rounded">
      <div className="flex justify-between items-center px-4 py-2 border-b border-white/10">
        <h3 className="font-semibold text-sm">Events {manifest && `(${events.length} / ${manifest.totalBytes} B)`}</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => void loadNextChunk()}
          className="text-xs bg-blue-600/30 hover:bg-blue-600/50 px-3 py-1 rounded disabled:opacity-50"
        >
          {!manifest ? 'Load manifest' : (loadedChunks < manifest.chunks.length && events.length < MAX_EVENTS ? `Load chunk ${loadedChunks + 1} / ${manifest.chunks.length}` : 'All loaded')}
        </button>
      </div>
      {err && <div className="px-4 py-2 text-red-400 text-xs">{err}</div>}
      <div className="font-mono text-xs max-h-96 overflow-y-auto">
        {events.map((ev, i) => (
          <div key={i} className="px-4 py-1 border-b border-white/5">
            {JSON.stringify(ev)}
          </div>
        ))}
        {events.length === 0 && !busy && (
          <div className="px-4 py-8 text-center opacity-60">Click "Load manifest" to start.</div>
        )}
        {events.length >= MAX_EVENTS && (
          <div className="px-4 py-2 text-amber-400 text-center">
            Hit MVP cap of {MAX_EVENTS} events. Phase 5 adds full replay.
          </div>
        )}
      </div>
    </div>
  );
}
