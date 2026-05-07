// Parity copy of apps/web/lib/upload/chain.ts.
// CLI ↔ web hash agreement is asserted in tests/dashboard/parity.test.ts.

import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export function hashChunk(prevHashHex: string, body: Buffer): string {
  if (!/^[0-9a-f]{64}$/.test(prevHashHex)) {
    throw new Error(`hashChunk: prev hash must be 64 lowercase hex chars`);
  }
  const prevBytes = Buffer.from(prevHashHex, 'hex');
  const hash = createHash('sha256');
  hash.update(body);
  hash.update(prevBytes);
  return hash.digest('hex');
}

/**
 * Compute the chain root for an ordered sequence of chunks.
 * Unambiguous loop form (per spec): prev=ZERO_HASH; for seq in 0..N-1:
 *   h[seq] = sha256(chunk[seq] || prev); prev = h[seq]; root = prev.
 */
export function computeChainRoot(chunks: Buffer[]): string {
  let prev = ZERO_HASH;
  for (const chunk of chunks) {
    prev = hashChunk(prev, chunk);
  }
  return prev;
}
