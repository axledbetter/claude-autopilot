// Parity copy of apps/web/lib/upload/canonical.ts (RFC 8785 / JCS).
// CLI ↔ web byte-equality asserted in tests/dashboard/parity.test.ts.

import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

export function canonicalJsonBytes(value: unknown): Buffer {
  // canonicalize implements RFC 8785 (JCS). Returns undefined only for
  // inputs JSON cannot represent at the root; coerce to '' so callers
  // always get a Buffer.
  const str = canonicalize(value) ?? '';
  return Buffer.from(str, 'utf-8');
}

export function sha256OfCanonical(value: unknown): string {
  const bytes = canonicalJsonBytes(value);
  return createHash('sha256').update(bytes).digest('hex');
}
