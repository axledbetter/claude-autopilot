import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/dashboard/audit-cursor';

describe('audit-cursor', () => {
  it('null/undefined → null', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('valid roundtrip', () => {
    const c = { occurredAt: '2026-04-15T12:00:00.123Z', id: 42 };
    const encoded = encodeCursor(c);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(c);
  });

  it('malformed base64 → invalid', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBe('invalid');
  });

  it('malformed JSON → invalid', () => {
    const notJson = Buffer.from('hello world', 'utf8').toString('base64');
    expect(decodeCursor(notJson)).toBe('invalid');
  });

  it('missing fields → invalid', () => {
    const noId = Buffer.from(JSON.stringify({ occurredAt: '2026-04-15T12:00:00Z' }), 'utf8').toString('base64');
    expect(decodeCursor(noId)).toBe('invalid');
  });

  it('wrong types → invalid', () => {
    const wrong = Buffer.from(JSON.stringify({ occurredAt: 'not-iso', id: 1 }), 'utf8').toString('base64');
    expect(decodeCursor(wrong)).toBe('invalid');
    const wrongId = Buffer.from(JSON.stringify({ occurredAt: '2026-04-15T12:00:00Z', id: 'foo' }), 'utf8').toString('base64');
    expect(decodeCursor(wrongId)).toBe('invalid');
  });
});
