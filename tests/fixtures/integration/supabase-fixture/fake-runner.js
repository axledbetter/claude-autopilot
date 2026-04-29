// Fake migrate.supabase runner for the Supabase integration test.
//
// Reads AUTOPILOT_ENVELOPE + AUTOPILOT_RESULT_PATH and writes a valid
// ResultArtifact with the side-effect set we expect from the supabase
// adapter (migration-ledger-updated + types-regenerated). Stands in for
// `tsx scripts/supabase/migrate.ts` so the test doesn't require a real
// Supabase project, network, or psql.
const fs = require('node:fs');

const env = JSON.parse(process.env.AUTOPILOT_ENVELOPE);
const out = {
  contractVersion: '1.0',
  skillId: 'migrate.supabase@1',
  invocationId: env.invocationId,
  nonce: env.nonce,
  status: 'applied',
  reasonCode: 'ok',
  appliedMigrations: ['20260429000000_init.sql'],
  destructiveDetected: false,
  sideEffectsPerformed: ['migration-ledger-updated', 'types-regenerated'],
  nextActions: ['regenerate-types'],
};
fs.writeFileSync(process.env.AUTOPILOT_RESULT_PATH, JSON.stringify(out));
