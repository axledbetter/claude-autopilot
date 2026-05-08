// /runs/[runShareId] — Phase 4 public share-by-URL.
//
// Server-side anon Supabase client (NOT createBrowserClient — codex
// WARNING). Anon SELECT policy from the migration handles RLS:
// `runs_select_public` allows SELECT on visibility='public' rows.
// Column-level GRANT to anon limits which columns are exposed.
//
// Param naming: [runShareId] (NOT [runId]) for code clarity (codex WARNING).
// Query uses runs.id (UUID — non-guessable, no separate share token in v7.0).

import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import PublicRunView, { type PublicRunRow } from '@/components/public/PublicRunView';

export const dynamic = 'force-dynamic';

export default async function PublicRunPage(
  { params }: { params: Promise<{ runShareId: string }> },
): Promise<React.ReactElement> {
  const { runShareId } = await params;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) notFound();

  const supabase = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data } = await supabase.from('runs')
    .select('id, source_verified, events_chain_root, total_bytes, cost_usd, duration_ms, run_status, created_at, visibility')
    .eq('id', runShareId)
    .eq('visibility', 'public')
    .maybeSingle();

  const run = data as PublicRunRow | null;
  if (!run) notFound();

  return <PublicRunView run={run} />;
}
