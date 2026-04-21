// Cross-platform test runner using Node 22 built-in fs.glob
import { glob } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = [];
for await (const f of glob('tests/**/*.test.ts')) {
  files.push(f);
}
files.sort();

const result = spawnSync(
  'node',
  ['--test', '--import', 'tsx', ...files],
  { stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);
