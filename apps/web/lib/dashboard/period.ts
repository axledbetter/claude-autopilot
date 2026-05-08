// YYYY-MM period parser. since/until inclusive UTC months.
// Codex pass 1 CRITICAL — explicit conversion to (sinceTs, untilTs exclusive).
// since=2026-04, until=2026-04 -> sinceTs=2026-04-01T00Z, untilTs=2026-05-01T00Z.

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface ParsedPeriod {
  sinceTs: Date;
  untilTs: Date;
  since: string;
  until: string;
}

export function parsePeriod(
  since: string | null | undefined,
  until: string | null | undefined,
): ParsedPeriod | null {
  const now = new Date();
  const defaultMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const s = since ?? defaultMonth;
  const u = until ?? defaultMonth;

  const sm = PERIOD_RE.exec(s);
  const um = PERIOD_RE.exec(u);
  if (!sm || !um) return null;

  const sinceTs = new Date(Date.UTC(Number(sm[1]), Number(sm[2]) - 1, 1, 0, 0, 0));
  const untilTs = new Date(Date.UTC(Number(um[1]), Number(um[2]), 1, 0, 0, 0));

  if (sinceTs >= untilTs) return null;
  return { sinceTs, untilTs, since: s, until: u };
}
