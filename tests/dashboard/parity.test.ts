import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashChunk,
  computeChainRoot,
  ZERO_HASH,
} from '../../src/dashboard/upload/chain.ts';
import {
  canonicalJsonBytes,
  sha256OfCanonical,
} from '../../src/dashboard/upload/canonical.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES_DIR = path.join(ROOT, 'apps', 'web', 'lib', 'upload', '__fixtures__');

interface ChainVector {
  description: string;
  chunks: string[];   // base64-encoded
  expected_root: string;
}

interface CanonVector {
  description: string;
  inputs: unknown[];
  expected_sha256: string;
}

async function loadJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, file), 'utf-8');
  return JSON.parse(raw) as T;
}

describe('CLI parity with apps/web (chain + canonical)', () => {
  it('chain hash matches web fixture root for every vector', async () => {
    const vectors = await loadJson<ChainVector[]>('chain-vectors.json');
    assert.ok(vectors.length > 0, 'fixture must have at least one vector');
    for (const v of vectors) {
      const buffers = v.chunks.map((c) => Buffer.from(c, 'base64'));
      const got = computeChainRoot(buffers);
      assert.strictEqual(got, v.expected_root, `mismatch on "${v.description}"`);
    }
  });

  it('hashChunk loop form is unambiguous and matches expected', async () => {
    const vectors = await loadJson<ChainVector[]>('chain-vectors.json');
    for (const v of vectors) {
      let prev = ZERO_HASH;
      for (const c of v.chunks) {
        prev = hashChunk(prev, Buffer.from(c, 'base64'));
      }
      assert.strictEqual(prev, v.expected_root, `loop form mismatch on "${v.description}"`);
    }
  });

  it('canonicalize matches web fixture sha256 for every input variant', async () => {
    const vectors = await loadJson<CanonVector[]>('state-canonicalization-vectors.json');
    assert.ok(vectors.length > 0, 'fixture must have at least one vector');
    for (const v of vectors) {
      for (let i = 0; i < v.inputs.length; i++) {
        const got = sha256OfCanonical(v.inputs[i]);
        assert.strictEqual(
          got,
          v.expected_sha256,
          `mismatch on "${v.description}" variant #${i}`,
        );
      }
    }
  });

  it('canonicalJsonBytes produces deterministic UTF-8 buffers', async () => {
    const vectors = await loadJson<CanonVector[]>('state-canonicalization-vectors.json');
    for (const v of vectors) {
      const buffers = v.inputs.map((x) => canonicalJsonBytes(x));
      // All variants in a vector share the same canonical form → identical bytes.
      for (let i = 1; i < buffers.length; i++) {
        assert.deepStrictEqual(buffers[i], buffers[0], `variant #${i} of "${v.description}"`);
      }
    }
  });
});
