import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase 5.1 RPC privilege model (codex pass 2 CRITICAL)', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../../../../../data/deltas/20260508140000_phase5_1_member_rpcs.sql'),
    'utf-8',
  );

  it('test 31b: REVOKE FROM PUBLIC, anon, authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  });

  it('test 31b: GRANT EXECUTE TO service_role', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+service_role/i);
  });

  it('test 31b: NO grant to authenticated', () => {
    // Ensure no later GRANT line gives execute back to authenticated.
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO\s+authenticated\s*;/i);
  });
});
