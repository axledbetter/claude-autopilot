import canonicalize from 'canonicalize';
import { createHash } from 'crypto';

export function canonicalJsonBytes(value: unknown): Buffer {
  // canonicalize implements RFC 8785 (JCS); returns a string in canonical
  // UTF-8 form. Returns undefined only for inputs JSON cannot represent
  // (e.g. functions or undefined at the root); we coerce to an empty
  // string in that case so downstream callers always get a Buffer.
  const str = canonicalize(value) ?? '';
  return Buffer.from(str, 'utf-8');
}

export function sha256OfCanonical(value: unknown): string {
  const bytes = canonicalJsonBytes(value);
  return createHash('sha256').update(bytes).digest('hex');
}
