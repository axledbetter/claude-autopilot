const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function normalizeValue(value: unknown, cwd?: string): unknown {
  if (typeof value === 'string') {
    if (ISO_TS_RE.test(value)) return '<timestamp>';
    if (UUID_RE.test(value)) return '<uuid>';
    if (cwd && value.startsWith(cwd + '/')) return value.slice(cwd.length + 1);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => normalizeValue(v, cwd));
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = normalizeValue((value as Record<string, unknown>)[key], cwd);
    }
    return sorted;
  }
  return value;
}

export function normalizeSnapshot(value: unknown, cwd?: string): string {
  return JSON.stringify(normalizeValue(value, cwd), null, 2);
}
