import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sha256OfCanonical } from '@/lib/upload/canonical';

interface CanonVector {
  description: string;
  inputs: unknown[];        // multiple inputs that should canonicalize identically
  expected_sha256: string;  // lowercase hex
}

const fixturesPath = join(__dirname, '..', '..', 'lib', 'upload', '__fixtures__', 'state-canonicalization-vectors.json');
const vectors: CanonVector[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

describe('JCS state canonicalization', () => {
  it('test 29: vectors produce identical sha256 across equivalent inputs', () => {
    for (const vector of vectors) {
      const hashes = vector.inputs.map(sha256OfCanonical);
      const distinct = new Set(hashes);
      expect(
        distinct.size,
        `${vector.description}: expected all inputs to canonicalize to same hash, got ${distinct.size} distinct: ${[...distinct].join(', ')}`,
      ).toBe(1);
      expect(hashes[0], vector.description).toBe(vector.expected_sha256);
    }
  });
});
