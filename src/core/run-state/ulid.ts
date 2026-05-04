// src/core/run-state/ulid.ts
//
// Tiny pure-TS ULID generator. We deliberately avoid pulling in the `ulid`
// npm package — the algorithm is short and the runtime dep budget for the
// engine is tight. Conforms to https://github.com/ulid/spec :
//
//   - 26 characters, Crockford's Base32 (no I, L, O, U).
//   - First 10 chars  = 48-bit Unix-millisecond timestamp (ms since epoch).
//   - Last 16 chars   = 80 bits of randomness (crypto.randomBytes).
//   - Lexicographic sort == chronological sort (within ms; tie-break is
//     random within the same ms — Phase 1 does not implement the optional
//     monotonic-overflow within-ms behavior, since runIDs are issued by a
//     single writer and one-per-millisecond is unreachable in practice).
//   - URL-safe (Crockford Base32 only emits [0-9A-Z]).

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32 alphabet (32 chars).
const ENCODING_LEN = ENCODING.length; // 32.
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_LEN = TIME_LEN + RANDOM_LEN; // 26.
/** Max representable timestamp = 2^48 - 1 ms. Sanity-check, not a bug
 *  most callers will hit (it's the year 10889). */
const TIME_MAX = 281474976710655;

/** Validate that a string matches the ULID shape (length + alphabet). */
export function isValidULID(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length !== ULID_LEN) return false;
  for (let i = 0; i < ULID_LEN; i++) {
    if (ENCODING.indexOf(s[i] as string) < 0) return false;
  }
  return true;
}

function encodeTime(now: number): string {
  if (!Number.isFinite(now) || now < 0 || now > TIME_MAX) {
    throw new RangeError(`ulid: timestamp out of range (got ${now})`);
  }
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  // 16 chars * 5 bits each = 80 bits. We draw 10 bytes (80 bits) of
  // crypto-grade randomness and encode 5 bits at a time. Any extra fractional
  // bits are discarded — this is the standard ULID approach.
  const bytes = randomBytes(10);
  // Pack the 10 bytes into a 80-bit unsigned integer view, 5-bit chunks.
  // We do it manually rather than using BigInt for portability — the array
  // is short enough that the explicit math is just as fast and avoids any
  // dependency on BigInt-typed regression in older runtimes.
  const bits: number[] = new Array(80);
  for (let i = 0; i < 10; i++) {
    const b = bytes[i] as number;
    for (let j = 0; j < 8; j++) {
      bits[i * 8 + j] = (b >> (7 - j)) & 1;
    }
  }
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) {
      v = (v << 1) | (bits[i * 5 + j] as number);
    }
    out += ENCODING[v];
  }
  return out;
}

/** Generate a new ULID. Optionally pass a fixed `now` (ms epoch) for tests. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Decode the timestamp-portion of a ULID back to ms epoch. Throws on
 *  malformed input. Useful for `runs list` ordering and for tests. */
export function decodeTime(id: string): number {
  if (!isValidULID(id)) {
    throw new Error(`ulid: not a valid ULID: ${String(id)}`);
  }
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i] as string);
    t = t * ENCODING_LEN + idx;
  }
  return t;
}

/** Exposed for tests that want to verify alphabet membership. */
export const ULID_ALPHABET = ENCODING;
export const ULID_LENGTH = ULID_LEN;
