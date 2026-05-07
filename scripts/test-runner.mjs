// Cross-platform test runner using Node 22 built-in fs.glob
import { glob } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = [];
for await (const f of glob('tests/**/*.test.ts')) {
  // RLS tests require a live Supabase stack + env credentials; they run
  // from a dedicated workflow (.github/workflows/db-tests.yml) via
  // `npm run test:rls`, not from the general test runner.
  if (f.startsWith('tests/rls/') || f.startsWith('tests\\rls\\')) continue;
  files.push(f);
}
files.sort();

const result = spawnSync(
  'node',
  ['--test', '--import', 'tsx', ...files],
  { stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);
