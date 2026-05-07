import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hashChunk, zeroHash } from '@/lib/upload/chain';

interface ChainVector {
  description: string;
  chunks: string[];        // base64-encoded chunk bodies
  expected_root: string;   // lowercase hex
}

const fixturesPath = join(__dirname, '..', '..', 'lib', 'upload', '__fixtures__', 'chain-vectors.json');
const vectors: ChainVector[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

describe('hashChunk + chain root', () => {
  it('test 27: chain vectors round-trip through server hash function', () => {
    for (const vector of vectors) {
      let prev = zeroHash;
      for (const chunkB64 of vector.chunks) {
        const body = Buffer.from(chunkB64, 'base64');
        prev = hashChunk(prev, body);
      }
      expect(prev, vector.description).toBe(vector.expected_root);
    }
  });

  it('test 28: empty body chunk yields a hash distinct from non-empty', () => {
    const empty = hashChunk(zeroHash, Buffer.alloc(0));
    const nonEmpty = hashChunk(zeroHash, Buffer.from('a'));
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).not.toBe(nonEmpty);
  });

  it('zeroHash is exactly 64 zero hex chars', () => {
    expect(zeroHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
  });
});
