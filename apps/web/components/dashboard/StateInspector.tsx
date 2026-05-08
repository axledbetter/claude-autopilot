'use client';

// State inspector — Phase 4 client component. Tiny recursive tree view.
// No JSON-tree library (~50 LOC budget).

import { useState } from 'react';

interface Props { state: unknown }

export default function StateInspector({ state }: Props): React.ReactElement {
  return (
    <div className="border border-white/10 rounded p-4 font-mono text-xs">
      <Node value={state} keyName="state" depth={0} />
    </div>
  );
}

function Node({ value, keyName, depth }: { value: unknown; keyName: string; depth: number }): React.ReactElement {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const indent = { paddingLeft: `${depth * 12}px` };

  if (!isObj) {
    return (
      <div style={indent}>
        <span className="opacity-60">{keyName}:</span>{' '}
        <span className={typeof value === 'string' ? 'text-green-400' : typeof value === 'number' ? 'text-amber-400' : 'opacity-90'}>
          {JSON.stringify(value)}
        </span>
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={indent}
        className="text-left hover:bg-white/5 w-full"
      >
        <span className="opacity-60">{open ? '▾' : '▸'} {keyName}</span>
        <span className="opacity-40 ml-1">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && entries.map(([k, v]) => (
        <Node key={k} value={v} keyName={k} depth={depth + 1} />
      ))}
    </div>
  );
}
