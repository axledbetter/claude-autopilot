// Fake migrate runner for the Prisma integration test.
//
// Reads the AUTOPILOT_ENVELOPE + AUTOPILOT_RESULT_PATH the dispatcher sets
// in the child env and writes a valid ResultArtifact echoing the envelope
// invocationId/nonce. Stands in for `prisma migrate deploy` so the test
// does not require a real Prisma binary in CI.
const fs = require('node:fs');

const env = JSON.parse(process.env.AUTOPILOT_ENVELOPE);
const out = {
  contractVersion: '1.0',
  skillId: 'migrate@1',
  invocationId: env.invocationId,
  nonce: env.nonce,
  status: 'applied',
  reasonCode: 'ok',
  appliedMigrations: ['20260429_init.sql'],
  destructiveDetected: false,
  sideEffectsPerformed: ['types-regenerated'],
  nextActions: ['regenerate-types'],
};
fs.writeFileSync(process.env.AUTOPILOT_RESULT_PATH, JSON.stringify(out));
