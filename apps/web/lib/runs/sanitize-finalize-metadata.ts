// Sanitize the finalize handler's state.json metadata fields.
//
// Phase 4 — runs.cost_usd / duration_ms / run_status are display-only
// estimates derived from the CLI-supplied state.json. Validate + bound
// in TS BEFORE the DB UPDATE so a buggy CLI doesn't trip the new CHECK
// constraints and fail the entire `runs.update(...)` (which would block
// the rest of finalize from persisting).
//
// Bounds:
//   - cost: $0..$1M (anomaly detection); 4 decimal places
//   - duration: 0..7 days
//   - status: enum ('completed','failed','partial')
//
// Out-of-range / wrong-type → null. UI displays "—" for null and
// labels these "Reported by CLI" — no entitlement/billing logic reads
// them.

const ALLOWED_STATUS = new Set(['completed', 'failed', 'partial']);
const MAX_COST_USD = 1_000_000;
const MAX_DURATION_MS = 7 * 24 * 3600 * 1000;

export interface SanitizedMetadata {
  cost_usd: number | null;
  duration_ms: number | null;
  run_status: string | null;
}

export function sanitizeFinalizeMetadata(state: unknown): SanitizedMetadata {
  if (state == null || typeof state !== 'object') {
    return { cost_usd: null, duration_ms: null, run_status: null };
  }
  const s = state as Record<string, unknown>;

  let cost: number | null = null;
  if (typeof s.cost_usd === 'number' && Number.isFinite(s.cost_usd)
      && s.cost_usd >= 0 && s.cost_usd <= MAX_COST_USD) {
    cost = Number(s.cost_usd.toFixed(4));
  }

  let duration: number | null = null;
  if (typeof s.duration_ms === 'number' && Number.isFinite(s.duration_ms)
      && s.duration_ms >= 0 && s.duration_ms <= MAX_DURATION_MS) {
    duration = Math.floor(s.duration_ms);
  }

  let status: string | null = null;
  if (typeof s.run_status === 'string' && ALLOWED_STATUS.has(s.run_status)) {
    status = s.run_status;
  }

  return { cost_usd: cost, duration_ms: duration, run_status: status };
}
