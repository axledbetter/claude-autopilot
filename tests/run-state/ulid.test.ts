import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ulid,
  decodeTime,
  isValidULID,
  ULID_ALPHABET,
  ULID_LENGTH,
} from '../../src/core/run-state/ulid.ts';

describe('ulid', () => {
  it('is exactly 26 characters', () => {
    const id = ulid();
    assert.equal(id.length, ULID_LENGTH);
    assert.equal(id.length, 26);
  });

  it('uses only Crockford Base32 alphabet (no I, L, O, U)', () => {
    const id = ulid();
    for (const ch of id) {
      assert.ok(ULID_ALPHABET.includes(ch), `unexpected char ${ch} in ${id}`);
    }
    assert.ok(!/[ILOU]/.test(id), `forbidden char in ${id}`);
  });

  it('isValidULID accepts a freshly-generated ULID', () => {
    assert.equal(isValidULID(ulid()), true);
  });

  it('isValidULID rejects wrong length', () => {
    assert.equal(isValidULID('ABC'), false);
    assert.equal(isValidULID('A'.repeat(27)), false);
  });

  it('isValidULID rejects forbidden characters', () => {
    // 26 chars but contains I/L/O/U
    assert.equal(isValidULID('I'.repeat(26)), false);
    assert.equal(isValidULID('LLLLLLLLLLLLLLLLLLLLLLLLLL'), false);
  });

  it('decodeTime round-trips a fixed timestamp', () => {
    const t = 1_700_000_000_000; // 2023-11-14
    const id = ulid(t);
    assert.equal(decodeTime(id), t);
  });

  it('sorts lexicographically by time (monotonic across millis)', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    const c = ulid(3_000_000);
    const sorted = [c, a, b].sort();
    assert.deepEqual(sorted, [a, b, c]);
  });

  it('two ULIDs with the same timestamp have different random parts', () => {
    const a = ulid(1234);
    const b = ulid(1234);
    assert.notEqual(a, b);
    // First 10 chars (time) should match.
    assert.equal(a.slice(0, 10), b.slice(0, 10));
  });

  it('throws on out-of-range timestamps', () => {
    assert.throws(() => ulid(-1), /out of range/);
    assert.throws(() => ulid(Number.MAX_SAFE_INTEGER), /out of range/);
  });
});
