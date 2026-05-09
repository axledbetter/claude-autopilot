import { describe, it, expect, beforeEach, vi } from 'vitest';

let mockResolveTxt: (fqdn: string) => Promise<string[][]>;
vi.mock('node:dns/promises', () => ({
  default: { resolveTxt: (fqdn: string) => mockResolveTxt(fqdn) },
  resolveTxt: (fqdn: string) => mockResolveTxt(fqdn),
}));

const { verifyTxtChallenge } = await import('@/lib/dns/verify-txt');

beforeEach(() => {
  mockResolveTxt = async () => [];
});

describe('verifyTxtChallenge', () => {
  it('matching TXT chunk → ok', async () => {
    mockResolveTxt = async () => [['my-token']];
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'my-token');
    expect(r).toEqual({ ok: true });
  });

  it('long TXT joined before compare → ok', async () => {
    mockResolveTxt = async () => [['part1-', 'part2']];
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'part1-part2');
    expect(r).toEqual({ ok: true });
  });

  it('multiple records, only one matches → ok', async () => {
    mockResolveTxt = async () => [['noise'], ['my-token']];
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'my-token');
    expect(r).toEqual({ ok: true });
  });

  it('no matching record → no_matching_txt_record', async () => {
    mockResolveTxt = async () => [['other-token']];
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'my-token');
    expect(r).toEqual({ ok: false, reason: 'no_matching_txt_record' });
  });

  it('ENOTFOUND → no_txt_records', async () => {
    mockResolveTxt = async () => {
      const e = new Error('not found') as Error & { code: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'my-token');
    expect(r).toEqual({ ok: false, reason: 'no_txt_records' });
  });

  it('hung resolver → timeout within bound', async () => {
    mockResolveTxt = () => new Promise(() => {});  // never resolves
    const start = Date.now();
    const r = await verifyTxtChallenge('_workos-verify.example.com', 'my-token', 200);
    const elapsed = Date.now() - start;
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(elapsed).toBeLessThan(500);
  });
});
