'use client';

// Audit filter bar — Phase 5.2. Single-action filter + clear button.

const KNOWN_ACTIONS = [
  'org.member.invited',
  'org.member.role_changed',
  'org.member.removed',
  'org.settings.updated',
  'run.uploaded',
] as const;

interface Props {
  action: string;
  onActionChange: (action: string) => void;
}

export default function AuditFilterBar({ action, onActionChange }: Props): React.ReactElement {
  return (
    <div className="flex gap-2 items-end">
      <label className="flex flex-col gap-1 text-xs opacity-70">
        Filter by action
        <select
          value={action}
          onChange={(e) => onActionChange(e.target.value)}
          className="bg-black/30 border border-white/10 rounded px-3 py-1 text-sm min-w-[240px]"
        >
          <option value="">All actions</option>
          {KNOWN_ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </label>
      {action && (
        <button
          type="button"
          onClick={() => onActionChange('')}
          className="text-xs underline opacity-70 hover:opacity-100"
        >
          Clear
        </button>
      )}
    </div>
  );
}
