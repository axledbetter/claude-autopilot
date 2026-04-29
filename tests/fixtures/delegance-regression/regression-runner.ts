// tests/fixtures/delegance-regression/regression-runner.ts
//
// Minimal harness that calls the new dispatcher against the regression
// fixture. Exit non-zero on any unexpected status. The CI workflow byte-
// compares the resulting _schema_migrations ledger to expected-ledger.json
// in a separate step.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../../../src/core/migrate/dispatcher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname);

const result = await dispatch({
  repoRoot,
  env: 'dev',
  yesFlag: false,
  nonInteractive: true,
  currentRuntimeVersion: '5.2.0',
  changedFiles: ['data/deltas/20260101000000_init.sql'],
});

if (result.status !== 'applied') {
  console.error('Migration failed:', JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log('Migration applied:', result.appliedMigrations);
