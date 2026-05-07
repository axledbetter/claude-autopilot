// Strict regex per spec CRITICAL #2 — only accept loopback HTTP URLs
// in the reserved CLI port range with the exact `/cli-callback` path.
const PATTERN = /^http:\/\/(127\.0\.0\.1|localhost):(560(0[0-9]|[1-4][0-9]|50))\/cli-callback$/;

export function validateCallbackUrl(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  if (!PATTERN.test(input)) return false;
  // Defensive double-parse — reject if URL semantics disagree with regex.
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:') return false;
    if (u.username || u.password) return false;
    if (u.search || u.hash) return false;
    if (u.pathname !== '/cli-callback') return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 56000 || port > 56050) return false;
    return true;
  } catch {
    return false;
  }
}
