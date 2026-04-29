// tests/fixtures/delegance-regression/mini-migrator.mjs
//
// Tiny fixture migrator for the Delegance regression CI lane. Speaks the
// claude-autopilot envelope contract: reads AUTOPILOT_ENVELOPE, writes a
// ResultArtifact JSON to AUTOPILOT_RESULT_PATH. Applies each changedFile
// to postgres and inserts a _schema_migrations row per migration.
//
// This is INTENTIONALLY minimal. It is not the real Delegance migrator —
// it just exercises the dispatcher → executor → result-parser path against
// a real postgres so the regression test can byte-compare the resulting
// ledger snapshot to expected-ledger.json.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import postgres from 'postgres';

const ENVELOPE_RAW = process.env.AUTOPILOT_ENVELOPE;
const RESULT_PATH = process.env.AUTOPILOT_RESULT_PATH;
const POSTGRES_URL = process.env.POSTGRES_URL;

function writeResult(result) {
  if (!RESULT_PATH) return;
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result));
}

function synthError(envelope, reasonCode) {
  return {
    contractVersion: '1.0',
    skillId: 'migrate.supabase@1',
    invocationId: envelope?.invocationId ?? 'unknown',
    nonce: envelope?.nonce ?? '',
    status: 'error',
    reasonCode,
    appliedMigrations: [],
    destructiveDetected: false,
    sideEffectsPerformed: ['no-side-effects'],
    nextActions: [],
  };
}

async function main() {
  if (!ENVELOPE_RAW) {
    console.error('mini-migrator: AUTOPILOT_ENVELOPE missing');
    process.exit(1);
  }
  const envelope = JSON.parse(ENVELOPE_RAW);

  if (!POSTGRES_URL) {
    writeResult(synthError(envelope, 'postgres-url-missing'));
    return;
  }

  const sql = postgres(POSTGRES_URL, { max: 1 });

  try {
    // Bootstrap ledger (idempotent — workflow also creates it up-front)
    await sql`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        checksum TEXT NOT NULL,
        environment TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT now(),
        applied_by TEXT DEFAULT 'claude-autopilot',
        success BOOLEAN NOT NULL,
        execution_ms INTEGER,
        error_message TEXT,
        UNIQUE(environment, version)
      )
    `;

    const applied = [];
    const repoRoot = envelope.repoRoot;
    const env = envelope.env;

    for (const relPath of envelope.changedFiles ?? []) {
      const abs = path.resolve(repoRoot, relPath);
      const sqlText = fs.readFileSync(abs, 'utf8');
      const version = path.basename(abs, '.sql');
      const checksum = crypto.createHash('sha256').update(sqlText, 'utf8').digest('hex');

      const t0 = Date.now();
      try {
        // Use unsafe() — this is a fixture migrator running against an
        // ephemeral CI postgres, not production.
        await sql.unsafe(sqlText);
        const ms = Date.now() - t0;
        await sql`
          INSERT INTO _schema_migrations (version, checksum, environment, success, execution_ms)
          VALUES (${version}, ${checksum}, ${env}, true, ${ms})
          ON CONFLICT (environment, version) DO NOTHING
        `;
        applied.push(version);
      } catch (err) {
        await sql`
          INSERT INTO _schema_migrations (version, checksum, environment, success, error_message)
          VALUES (${version}, ${checksum}, ${env}, false, ${String(err?.message ?? err)})
          ON CONFLICT (environment, version) DO NOTHING
        `;
        writeResult({
          contractVersion: '1.0',
          skillId: 'migrate.supabase@1',
          invocationId: envelope.invocationId,
          nonce: envelope.nonce,
          status: 'error',
          reasonCode: 'sql-execution-failed',
          appliedMigrations: applied,
          destructiveDetected: false,
          sideEffectsPerformed: ['migration-ledger-updated'],
          nextActions: [],
        });
        return;
      }
    }

    writeResult({
      contractVersion: '1.0',
      skillId: 'migrate.supabase@1',
      invocationId: envelope.invocationId,
      nonce: envelope.nonce,
      status: 'applied',
      reasonCode: 'ok',
      appliedMigrations: applied,
      destructiveDetected: false,
      sideEffectsPerformed: applied.length > 0 ? ['migration-ledger-updated'] : ['no-side-effects'],
      nextActions: [],
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('mini-migrator: unexpected error', err);
  process.exit(2);
});
