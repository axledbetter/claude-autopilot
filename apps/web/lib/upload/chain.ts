import { createHash } from 'crypto';

export const zeroHash = '0'.repeat(64);

export function hashChunk(prevHashHex: string, bodyBytes: Buffer): string {
  if (!/^[0-9a-f]{64}$/.test(prevHashHex)) {
    throw new Error(`hashChunk: prev hash must be 64 lowercase hex chars, got: ${prevHashHex}`);
  }
  const prevBytes = Buffer.from(prevHashHex, 'hex');
  const hash = createHash('sha256');
  hash.update(bodyBytes);
  hash.update(prevBytes);
  return hash.digest('hex');
}
