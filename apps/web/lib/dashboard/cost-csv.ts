// RFC 4180 CSV encoder for Phase 5.2 cost reports.
// CRLF row terminator, UTF-8 no BOM, double-quote escape on `,` `"` `\n` `\r`.
// Codex pass 1 CRITICAL — safe filename builder (no org name interpolation).

export interface CostRow {
  user_id: string;
  email: string | null;
  run_count: number;
  cost_usd_sum: number;
  duration_ms_sum: number;
  total_bytes_sum: number;
}

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function escapeCell(v: string | number | null): string {
  let s = v == null ? '' : String(v);
  // Codex PR-pass CRITICAL — spreadsheet formula injection guard.
  // Cells starting with =, +, -, @, tab, or CR can execute as formulas in
  // Excel/Sheets. Prefix with apostrophe to neutralize.
  if (FORMULA_LEAD.test(s)) {
    s = `'${s}`;
  }
  if (NEEDS_QUOTING.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function encodeCostCsv(rows: CostRow[]): string {
  const header = 'user_id,email,run_count,cost_usd_sum,duration_ms_sum,total_bytes_sum';
  const dataRows = rows.map((r) => [
    escapeCell(r.user_id),
    escapeCell(r.email),
    escapeCell(r.run_count),
    escapeCell(r.cost_usd_sum),
    escapeCell(r.duration_ms_sum),
    escapeCell(r.total_bytes_sum),
  ].join(','));
  return [header, ...dataRows].join('\r\n') + '\r\n';
}

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

export function buildCsvFilename(orgId: string, since: string, until: string): string {
  const candidate = `cost-${orgId}-${since}-${until}.csv`;
  if (!SAFE_FILENAME.test(candidate)) {
    throw new Error('unsafe_filename');
  }
  return candidate;
}
