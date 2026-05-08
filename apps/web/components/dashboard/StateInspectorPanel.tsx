'use client';

// StateInspectorPanel — Phase 4 lazy wrapper around StateInspector.
//
// Run detail page is a Server Component, but state.json is an artifact
// that lives in private storage. The user opts in by clicking "Show run
// state" (one click = one signed-URL mint + one fetch). We don't pre-load
// because most users browse runs without inspecting state, and state.json
// can be tens of KB.

import { useState } from 'react';
import StateInspector from './StateInspector';

interface Props { runId: string }

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; value: unknown };

export default function StateInspectorPanel({ runId }: Props): React.ReactElement {
  const [state, setState] = useState<State>({ phase: 'idle' });

  async function load(): Promise<void> {
    setState({ phase: 'loading' });
    try {
      const mintRes = await fetch(`/api/dashboard/runs/${runId}/artifact?kind=state`, {
        credentials: 'include',
      });
      if (!mintRes.ok) {
        setState({ phase: 'error', message: `mint failed (${mintRes.status})` });
        return;
      }
      const { url } = await mintRes.json() as { url: string };
      const stateRes = await fetch(url);
      if (!stateRes.ok) {
        setState({ phase: 'error', message: `fetch failed (${stateRes.status})` });
        return;
      }
      const value: unknown = await stateRes.json();
      setState({ phase: 'loaded', value });
    } catch (err) {
      setState({ phase: 'error', message: (err as Error).message });
    }
  }

  if (state.phase === 'loaded') {
    return <StateInspector state={state.value} />;
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => void load()}
        disabled={state.phase === 'loading'}
        className="text-sm underline opacity-80 hover:opacity-100 disabled:opacity-40"
      >
        {state.phase === 'loading' ? 'Loading…' : 'Show run state'}
      </button>
      {state.phase === 'error' && (
        <div className="text-xs text-red-400 mt-2">Failed: {state.message}</div>
      )}
    </div>
  );
}
