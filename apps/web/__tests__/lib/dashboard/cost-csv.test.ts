import { describe, it, expect } from 'vitest';
import { encodeCostCsv, buildCsvFilename, type CostRow } from '@/lib/dashboard/cost-csv';

describe('encodeCostCsv', () => {
  it('emits header + simple row with CRLF', () => {
    const rows: CostRow[] = [{
      user_id: '00000000-0000-0000-0000-000000000001',
      email: 'user@example.com',
      run_count: 12,
      cost_usd_sum: 1.5,
      duration_ms_sum: 1000,
      total_bytes_sum: 2048,
    }];
    const csv = encodeCostCsv(rows);
    expect(csv).toBe(
      'user_id,email,run_count,cost_usd_sum,duration_ms_sum,total_bytes_sum\r\n' +
      '00000000-0000-0000-0000-000000000001,user@example.com,12,1.5,1000,2048\r\n',
    );
  });

  it('escapes comma in email', () => {
    const rows: CostRow[] = [{
      user_id: 'u', email: 'foo,bar@example.com', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0,
    }];
    expect(encodeCostCsv(rows)).toContain('"foo,bar@example.com"');
  });

  it('escapes quote (doubled)', () => {
    const rows: CostRow[] = [{
      user_id: 'u', email: 'fo"o@example.com', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0,
    }];
    expect(encodeCostCsv(rows)).toContain('"fo""o@example.com"');
  });

  it('escapes newline in email (preserves CRLF inside quoted field)', () => {
    const rows: CostRow[] = [{
      user_id: 'u', email: 'foo\nbar@example.com', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0,
    }];
    const csv = encodeCostCsv(rows);
    expect(csv).toContain('"foo\nbar@example.com"');
  });

  it('codex-pr CRITICAL: prefixes formula-leading chars with apostrophe', () => {
    const rows: CostRow[] = [{
      user_id: 'u', email: '=cmd|notepad!A1', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0,
    }];
    expect(encodeCostCsv(rows)).toContain("'=cmd|notepad!A1");
  });

  it('codex-pr CRITICAL: handles + and - leading chars too', () => {
    const rows: CostRow[] = [
      { user_id: '+1', email: '-2', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0 },
      { user_id: '@cmd', email: 'x', run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0 },
    ];
    const csv = encodeCostCsv(rows);
    expect(csv).toContain("'+1");
    expect(csv).toContain("'-2");
    expect(csv).toContain("'@cmd");
  });

  it('null email rendered as empty cell (no quotes needed)', () => {
    const rows: CostRow[] = [{
      user_id: 'u', email: null, run_count: 1, cost_usd_sum: 0, duration_ms_sum: 0, total_bytes_sum: 0,
    }];
    expect(encodeCostCsv(rows)).toContain('u,,1,0,0,0');
  });
});

describe('buildCsvFilename', () => {
  it('valid orgId UUID + valid period → safe filename', () => {
    const f = buildCsvFilename('00000000-0000-0000-0000-000000000001', '2026-04', '2026-04');
    expect(f).toBe('cost-00000000-0000-0000-0000-000000000001-2026-04-2026-04.csv');
    // codex CRITICAL — no header-injection chars
    expect(f).not.toMatch(/["\r\n;]/);
  });

  it('throws on unsafe orgId', () => {
    expect(() => buildCsvFilename('not safe', '2026-04', '2026-04')).toThrow('unsafe_filename');
    expect(() => buildCsvFilename('"; rm -rf /', '2026-04', '2026-04')).toThrow('unsafe_filename');
  });

  it('throws on unsafe period', () => {
    expect(() => buildCsvFilename('00000000-0000-0000-0000-000000000001', 'bad period', '2026-04')).toThrow('unsafe_filename');
  });
});
