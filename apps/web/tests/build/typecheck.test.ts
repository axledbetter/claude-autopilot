import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('apps/web typecheck', () => {
  it('tsc --noEmit returns 0', () => {
    const cwd = path.resolve(__dirname, '../..');
    const result = spawnSync('npx', ['tsc', '--noEmit'], {
      cwd,
      encoding: 'utf-8',
      shell: false,
    });
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }
    expect(result.status).toBe(0);
  });
});
