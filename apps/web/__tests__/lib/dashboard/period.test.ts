import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parsePeriod } from '@/lib/dashboard/period';

describe('parsePeriod', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('same-month: 2026-04 → April only', () => {
    const p = parsePeriod('2026-04', '2026-04');
    expect(p).not.toBeNull();
    expect(p!.sinceTs.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(p!.untilTs.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(p!.since).toBe('2026-04');
    expect(p!.until).toBe('2026-04');
  });

  it('multi-month: 2026-01 → 2026-03 covers Jan, Feb, Mar', () => {
    const p = parsePeriod('2026-01', '2026-03');
    expect(p!.sinceTs.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(p!.untilTs.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('December → January year boundary', () => {
    const p = parsePeriod('2026-12', '2026-12');
    expect(p!.sinceTs.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(p!.untilTs.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('leap-year February (2028)', () => {
    const p = parsePeriod('2028-02', '2028-02');
    expect(p!.sinceTs.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(p!.untilTs.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('malformed since → null', () => {
    expect(parsePeriod('2026-13', '2026-04')).toBeNull();
    expect(parsePeriod('26-04', '2026-04')).toBeNull();
    expect(parsePeriod('abc', '2026-04')).toBeNull();
  });

  it('since > until → null', () => {
    expect(parsePeriod('2026-05', '2026-04')).toBeNull();
  });

  it('default current month UTC when both null', () => {
    const p = parsePeriod(null, null);
    expect(p!.since).toBe('2026-04');
    expect(p!.sinceTs.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
