// Audit pagination cursor — base64-encoded JSON {occurredAt, id}.
// Route validates before passing typed (timestamptz, bigint) to RPC.

export interface AuditCursor {
  occurredAt: string;
  id: number;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function decodeCursor(s: string | null | undefined): AuditCursor | null | 'invalid' {
  if (!s) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (!json || typeof json !== 'object') return 'invalid';
  const obj = json as Record<string, unknown>;
  if (typeof obj.occurredAt !== 'string' || !ISO_RE.test(obj.occurredAt)) return 'invalid';
  if (typeof obj.id !== 'number' || !Number.isInteger(obj.id) || obj.id < 0) return 'invalid';
  return { occurredAt: obj.occurredAt, id: obj.id };
}

export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
}
