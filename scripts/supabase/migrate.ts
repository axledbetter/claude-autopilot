/**
 * Migration runner CLI — orchestrates ledger bootstrap, advisory locks,
 * validation, three-phase execution, promotion, and type generation.
 *
 * Usage:
 *   npx tsx scripts/supabase/migrate.ts <file> --env dev|qa|prod [--dry-run] [--force]
 *   npx tsx scripts/supabase/migrate.ts --promote qa|prod [--force] [--confirm-prod]
 *   npx tsx scripts/supabase/migrate.ts --inspect <name> [--env dev|qa|prod]
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, computeChecksum, loadMigrationFile, getPromotionSource } from './config';
import { createExecutor } from './executor';
import { validateMigrationSQL } from './validate';
import { generateTypesFile, SCHEMA_QUERY, ENUM_QUERY } from './gen-types';
import { inspectObject, generateSchemaSummary } from './schema-inspect';
import type { Environment, MigrationExecutor, MigrationFile, LedgerRow, Finding } from './types';
import type { SchemaTable, SchemaEnum, SchemaInfo } from './gen-types';

// ── Autopilot envelope shim ──
// When invoked by claude-autopilot's dispatcher, AUTOPILOT_ENVELOPE
// carries the canonical invocation envelope and AUTOPILOT_RESULT_PATH
// is where we must write the ResultArtifact JSON. When neither is set,
// fall back to legacy CLI-arg behavior unchanged.

interface AutopilotEnvelope {
  contractVersion: string;
  invocationId: string;
  nonce: string;
  env: string;
  changedFiles: string[];
  dryRun: boolean;
  repoRoot: string;
  // … other fields ignored by this script
}

type ResultStatus = 'applied' | 'skipped' | 'validation-failed' | 'needs-human' | 'error';

const AUTOPILOT_ENVELOPE_RAW = process.env.AUTOPILOT_ENVELOPE;
const AUTOPILOT_RESULT_PATH = process.env.AUTOPILOT_RESULT_PATH;

let autopilotEnvelope: AutopilotEnvelope | null = null;
if (AUTOPILOT_ENVELOPE_RAW) {
  try {
    autopilotEnvelope = JSON.parse(AUTOPILOT_ENVELOPE_RAW) as AutopilotEnvelope;
  } catch {
    // Malformed envelope — fall back to legacy CLI behavior
    autopilotEnvelope = null;
  }
}

let resultArtifactWritten = false;

function writeResultArtifact(artifact: {
  status: ResultStatus;
  reasonCode: string;
  appliedMigrations?: string[];
  destructiveDetected?: boolean;
  sideEffectsPerformed?: string[];
  nextActions?: string[];
}): void {
  if (!autopilotEnvelope || !AUTOPILOT_RESULT_PATH) return;
  if (resultArtifactWritten) return;
  const result = {
    contractVersion: '1.0',
    skillId: 'migrate.supabase@1',
    invocationId: autopilotEnvelope.invocationId,
    nonce: autopilotEnvelope.nonce,
    status: artifact.status,
    reasonCode: artifact.reasonCode,
    appliedMigrations: artifact.appliedMigrations ?? [],
    destructiveDetected: artifact.destructiveDetected ?? false,
    sideEffectsPerformed: artifact.sideEffectsPerformed ?? ['no-side-effects'],
    nextActions: artifact.nextActions ?? [],
  };
  try {
    fs.writeFileSync(AUTOPILOT_RESULT_PATH, JSON.stringify(result));
    resultArtifactWritten = true;
  } catch {
    // best-effort — don't crash the migration on artifact-write failure
  }
}

// ── Constants ──

/**
 * Quote-escape a value for safe inclusion as a SQL string literal.
 *
 * Defense-in-depth: the actual sources for these values today are
 *   - migration filenames (path.basename(filePath, '.sql'))
 *   - hex checksums computed by us
 *   - literal env names ('dev'|'qa'|'prod')
 *   - error messages from the executor
 *
 * None of those are attacker-controlled in the normal flow, but the
 * MigrationExecutor interface only takes raw SQL strings (no parameter
 * binding). Rather than refactor the executor, we centralize the escape
 * here so every interpolation point is uniformly hardened.
 *
 * Per Postgres SQL spec, doubling an embedded `'` is sufficient to
 * terminate the string literal safely.
 */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

const LEDGER_TABLE = '_schema_migrations';
const LOCK_CLASS_ID = 741953;
const ENV_LOCK_IDS: Record<string, number> = { dev: 1, qa: 2, prod: 3 };

const LEDGER_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  environment TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT now(),
  applied_by TEXT DEFAULT 'claude-code',
  success BOOLEAN NOT NULL,
  execution_ms INTEGER,
  error_message TEXT,
  UNIQUE(environment, version)
);`;

// ── Advisory Lock ──

async function acquireLock(executor: MigrationExecutor, env: string): Promise<void> {
  const objId = ENV_LOCK_IDS[env];
  const result = await executor.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(${LOCK_CLASS_ID}, ${objId}) as acquired`
  );
  if (!result[0]?.acquired) {
    throw new Error(`Another migration is running against ${env}. Wait or check for stale locks.`);
  }
}

async function releaseLock(executor: MigrationExecutor, env: string): Promise<void> {
  const objId = ENV_LOCK_IDS[env];
  await executor.execute(`SELECT pg_advisory_unlock(${LOCK_CLASS_ID}, ${objId})`);
}

// ── Ledger Functions ──

async function bootstrapLedger(executor: MigrationExecutor): Promise<void> {
  await executor.execute(LEDGER_BOOTSTRAP_SQL);
}

async function getLedgerEntries(executor: MigrationExecutor, env: string): Promise<LedgerRow[]> {
  // sqlEscape is defense-in-depth — `env` is a literal 'dev'|'qa'|'prod'
  // in the normal flow, but the executor takes raw SQL with no param binding.
  return executor.query<LedgerRow>(
    `SELECT * FROM ${LEDGER_TABLE} WHERE environment = '${sqlEscape(env)}' AND success = true ORDER BY version`
  );
}

async function writeLedgerStarted(executor: MigrationExecutor, migration: MigrationFile, env: string): Promise<void> {
  // Defense-in-depth: filename (version) and checksum are validated upstream
  // and not user-controlled, but the executor offers no parameter binding,
  // so quote-escape every interpolated string literal.
  const v = sqlEscape(migration.version);
  const c = sqlEscape(migration.checksum);
  const e = sqlEscape(env);
  await executor.execute(`
    INSERT INTO ${LEDGER_TABLE} (version, checksum, environment, success, applied_by)
    VALUES ('${v}', '${c}', '${e}', false, 'claude-code')
    ON CONFLICT (environment, version) DO UPDATE SET
      success = false, applied_at = now(), error_message = NULL, checksum = '${c}'
  `);
}

async function writeLedgerResult(
  executor: MigrationExecutor, migration: MigrationFile, env: string,
  success: boolean, durationMs: number, errorMessage?: string
): Promise<void> {
  const errorEscaped = errorMessage ? sqlEscape(errorMessage).slice(0, 1000) : null;
  // success is a boolean and durationMs is a number — both safe to inline.
  // env and version are quote-escaped for defense-in-depth.
  await executor.execute(`
    UPDATE ${LEDGER_TABLE} SET
      success = ${success}, execution_ms = ${durationMs},
      error_message = ${errorEscaped ? `'${errorEscaped}'` : 'NULL'}
    WHERE environment = '${sqlEscape(env)}' AND version = '${sqlEscape(migration.version)}'
  `);
}

// ── Local Fallback Log ──

function writeLocalFallbackLog(migration: MigrationFile, env: string, success: boolean, durationMs: number, error?: string): void {
  const logDir = path.join(process.cwd(), '.claude', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'migration-fallback.jsonl');
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    version: migration.version,
    checksum: migration.checksum,
    environment: env,
    success,
    durationMs,
    error,
  });
  fs.appendFileSync(logPath, entry + '\n');
  console.error(`  FALLBACK: Ledger write failed. Logged to ${logPath}`);
}

// ── Post-Execution RLS Verification ──

async function verifyPostExecRLS(executor: MigrationExecutor, sql: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["]?(\w+)["]?/gi;
  const newTables: string[] = [];
  let match;
  while ((match = createTableRegex.exec(sql)) !== null) {
    newTables.push(match[1].toLowerCase());
  }

  for (const table of newTables) {
    // Defense-in-depth: table names came from a regex-extracted CREATE TABLE,
    // so they're already restricted to \w+ — but the executor takes raw SQL,
    // so quote-escape uniformly.
    const tableEsc = sqlEscape(table);
    // Check RLS enabled
    const rlsResult = await executor.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = '${tableEsc}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`
    );
    if (!rlsResult[0]?.relrowsecurity) {
      findings.push({ check: 'post-exec-rls', severity: 'error', message: `Table ${table} created without RLS enabled` });
      continue;
    }

    // Check at least one policy exists
    const policyResult = await executor.query<{ count: string }>(
      `SELECT count(*)::text as count FROM pg_policies WHERE tablename = '${tableEsc}' AND schemaname = 'public'`
    );
    if (!policyResult[0] || parseInt(policyResult[0].count) === 0) {
      findings.push({ check: 'post-exec-rls', severity: 'error', message: `Table ${table} has RLS enabled but no policies defined` });
    }
  }

  return findings;
}

// ── Load Existing Migrations for Duplicate Checking ──

function loadExistingMigrationsSql(): string[] {
  const deltasDir = path.join(process.cwd(), 'data', 'deltas');
  if (!fs.existsSync(deltasDir)) return [];
  return fs.readdirSync(deltasDir)
    .filter(f => f.endsWith('.sql'))
    .map(f => fs.readFileSync(path.join(deltasDir, f), 'utf8'));
}

// ── Single Migration Execution (Three-Phase) ──

async function executeMigration(
  executor: MigrationExecutor, migration: MigrationFile, env: Environment,
  force: boolean, dryRun: boolean
): Promise<boolean> {
  // Validate
  const existingSql = loadExistingMigrationsSql().filter(s => s !== migration.sql);
  const validation = validateMigrationSQL(migration.sql, migration.path, existingSql, force);

  if (validation.warnings.length > 0) {
    console.error(`  Warnings:`);
    for (const w of validation.warnings) console.error(`    WARN [${w.check}]: ${w.message}`);
  }

  if (!validation.passed) {
    console.error(`  Validation FAILED:`);
    for (const e of validation.errors) console.error(`    ERROR [${e.check}]: ${e.message}`);
    return false;
  }

  if (dryRun) {
    console.error(`  Validation passed (dry run - not executing)`);
    return true;
  }

  // Phase 1: Write "started" ledger entry
  try {
    await writeLedgerStarted(executor, migration, env);
  } catch (err: any) {
    writeLocalFallbackLog(migration, env, false, 0, `Ledger start failed: ${err.message}`);
  }

  // Phase 2: Execute migration
  console.error(`  Executing ${migration.version} on ${env}...`);
  const result = await executor.execute(`BEGIN;\n${migration.sql}\nCOMMIT;`);

  // Phase 3: Update ledger with result
  try {
    await writeLedgerResult(executor, migration, env, result.success, result.durationMs, result.error);
  } catch (err: any) {
    writeLocalFallbackLog(migration, env, result.success, result.durationMs, result.error);
  }

  if (!result.success) {
    console.error(`  Migration failed (${result.durationMs}ms): ${result.error}`);
    return false;
  }

  console.error(`  Migration applied (${result.durationMs}ms)`);

  // Post-exec RLS verification
  const rlsFindings = await verifyPostExecRLS(executor, migration.sql);
  if (rlsFindings.length > 0) {
    console.error(`  Post-execution RLS issues:`);
    for (const f of rlsFindings) console.error(`    ${f.message}`);
  }

  // Auto-generate schema summary (fail-safe — doesn't block migration)
  try {
    const summary = await generateSchemaSummary(executor, env);
    const summaryPath = path.join(process.cwd(), 'docs', 'schema-summary.md');
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, summary, 'utf8');
    console.error('  docs/schema-summary.md regenerated');
  } catch (err: any) {
    console.error(`  Warning: schema summary generation failed: ${err.message}`);
  }

  return true;
}

// ── Promotion Logic ──

async function promote(targetEnv: Environment, force: boolean): Promise<void> {
  const config = loadConfig();
  const sourceEnv = getPromotionSource(targetEnv);

  const sourceExec = createExecutor(config[sourceEnv]);
  const targetExec = createExecutor(config[targetEnv]);

  try {
    await bootstrapLedger(sourceExec);
    await bootstrapLedger(targetExec);

    const sourceLedger = await getLedgerEntries(sourceExec, sourceEnv);
    const targetLedger = await getLedgerEntries(targetExec, targetEnv);

    const targetVersions = new Set(targetLedger.map(r => r.version));
    const missing = sourceLedger.filter(r => !targetVersions.has(r.version));

    if (missing.length === 0) {
      console.error(`  ${targetEnv} is up to date with ${sourceEnv}. Nothing to promote.`);
      return;
    }

    // Verify local files exist with matching checksums
    for (const entry of missing) {
      const localPath = path.join(process.cwd(), 'data', 'deltas', `${entry.version}.sql`);
      if (!fs.existsSync(localPath)) {
        throw new Error(`Migration ${entry.version} exists in ${sourceEnv} ledger but file not found at ${localPath}`);
      }
      const localChecksum = computeChecksum(fs.readFileSync(localPath, 'utf8'));
      if (localChecksum !== entry.checksum) {
        throw new Error(`Checksum mismatch for ${entry.version}: ledger=${entry.checksum.slice(0, 8)}... local=${localChecksum.slice(0, 8)}...`);
      }
    }

    // If promoting to prod, verify QA has everything
    if (targetEnv === 'prod') {
      const qaExec = createExecutor(config.qa);
      const qaLedger = await getLedgerEntries(qaExec, 'qa');
      const qaVersions = new Set(qaLedger.map(r => r.version));
      const missingFromQa = missing.filter(m => !qaVersions.has(m.version));
      await qaExec.close();
      if (missingFromQa.length > 0) {
        throw new Error(`Cannot promote to prod - QA is missing: ${missingFromQa.map(m => m.version).join(', ')}. Run --promote qa first.`);
      }
    }

    console.error(`  Promoting ${missing.length} migration(s) from ${sourceEnv} to ${targetEnv}:`);
    for (const entry of missing) {
      console.error(`    ${entry.version}`);
    }

    // Acquire lock on target
    await acquireLock(targetExec, targetEnv);

    try {
      for (const entry of missing) {
        const migration = loadMigrationFile(path.join(process.cwd(), 'data', 'deltas', `${entry.version}.sql`));
        const success = await executeMigration(targetExec, migration, targetEnv, force, false);
        if (!success) {
          throw new Error(`Migration ${entry.version} failed on ${targetEnv}. Stopping promotion.`);
        }
      }
    } finally {
      await releaseLock(targetExec, targetEnv);
    }

    console.error(`  Promoted ${missing.length} migration(s) to ${targetEnv}`);
  } finally {
    await sourceExec.close();
    await targetExec.close();
  }
}

// ── Type Generation ──

async function regenerateTypes(env: Environment): Promise<void> {
  const config = loadConfig();
  const executor = createExecutor(config[env]);

  try {
    // Fetch tables schema
    const tableRows = await executor.query<SchemaTable>(SCHEMA_QUERY);
    if (!tableRows || tableRows.length === 0) {
      console.error(`  Could not fetch schema from ${env} - skipping type generation`);
      return;
    }

    // Fetch enums
    let enums: SchemaEnum[] | null = null;
    try {
      enums = await executor.query<SchemaEnum>(ENUM_QUERY);
      if (enums && enums.length === 0) enums = null;
    } catch {
      // Enums query may fail if no enums exist
    }

    const schema: SchemaInfo = { tables: tableRows, enums };

    // Generate and write types
    const typesContent = generateTypesFile(schema);
    const typesPath = path.join(process.cwd(), 'types', 'supabase.ts');
    fs.writeFileSync(typesPath, typesContent, 'utf8');
    console.error(`  types/supabase.ts regenerated from ${env} schema`);
  } finally {
    await executor.close();
  }
}

// ── CLI Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags (legacy CLI behavior)
  const cliEnvFlag = args.find(a => a.startsWith('--env='))?.split('=')[1]
    || (args.includes('--env') ? args[args.indexOf('--env') + 1] : undefined);
  const promoteFlag = args.find(a => a.startsWith('--promote='))?.split('=')[1]
    || (args.includes('--promote') ? args[args.indexOf('--promote') + 1] : undefined);
  const inspectFlag = args.find(a => a.startsWith('--inspect='))?.split('=')[1]
    || (args.includes('--inspect') ? args[args.indexOf('--inspect') + 1] : undefined);
  const cliDryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const confirmProd = args.includes('--confirm-prod');

  // Inspect mode (envelope never overrides this — it's a manual diagnostic)
  if (inspectFlag) {
    const env = (cliEnvFlag || 'dev') as Environment;
    const config = loadConfig();
    const executor = createExecutor(config[env]);
    try {
      const result = await inspectObject(executor, inspectFlag);
      console.log(result);
    } finally {
      await executor.close();
    }
    return;
  }

  // Promotion mode (envelope never overrides — promotion is a deliberate manual op)
  if (promoteFlag) {
    const target = promoteFlag as Environment;
    if (!['qa', 'prod'].includes(target)) {
      console.error('--promote must be qa or prod');
      writeResultArtifact({ status: 'error', reasonCode: 'invalid-promote-target' });
      process.exit(1);
    }
    if (target === 'prod' && !confirmProd) {
      console.error('Prod promotion requires --confirm-prod flag');
      writeResultArtifact({ status: 'needs-human', reasonCode: 'prod-confirm-required' });
      process.exit(1);
    }
    await promote(target, force);
    await regenerateTypes(target);
    writeResultArtifact({
      status: 'applied',
      reasonCode: 'promotion-completed',
      sideEffectsPerformed: ['migration-ledger-updated', 'types-regenerated'],
      nextActions: [],
    });
    return;
  }

  // Single file mode — derive args from envelope if running under autopilot
  let filePath: string | undefined;
  let env: Environment;
  let dryRun: boolean;
  if (autopilotEnvelope) {
    env = autopilotEnvelope.env as Environment;
    // Use first .sql file in changedFiles as the migration to apply
    filePath = autopilotEnvelope.changedFiles.find(f => f.endsWith('.sql'));
    dryRun = !!autopilotEnvelope.dryRun;
  } else {
    filePath = args.find(a => !a.startsWith('--'));
    env = (cliEnvFlag || 'dev') as Environment;
    dryRun = cliDryRun;
  }

  if (!filePath) {
    if (autopilotEnvelope) {
      writeResultArtifact({
        status: 'skipped',
        reasonCode: 'no-sql-files-in-envelope',
      });
      return;
    }
    console.error('Usage:');
    console.error('  npx tsx scripts/supabase/migrate.ts <file> --env dev|qa|prod [--dry-run] [--force]');
    console.error('  npx tsx scripts/supabase/migrate.ts --promote qa|prod [--force] [--confirm-prod]');
    process.exit(1);
  }

  if (env === 'prod' && !confirmProd && !autopilotEnvelope) {
    console.error('Prod migration requires --confirm-prod flag');
    writeResultArtifact({ status: 'needs-human', reasonCode: 'prod-confirm-required' });
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    writeResultArtifact({ status: 'error', reasonCode: 'migration-file-not-found' });
    process.exit(1);
  }

  const config = loadConfig();
  const executor = createExecutor(config[env]);

  try {
    await bootstrapLedger(executor);

    if (!dryRun) {
      await acquireLock(executor, env);
    }

    try {
      const migration = loadMigrationFile(filePath);

      // Check if already applied
      const ledger = await getLedgerEntries(executor, env);
      const existing = ledger.find(r => r.version === migration.version);
      if (existing) {
        if (existing.checksum === migration.checksum) {
          console.error(`  Migration ${migration.version} already applied on ${env}. Skipping.`);
          writeResultArtifact({
            status: 'skipped',
            reasonCode: 'already-applied',
            appliedMigrations: [],
          });
          return;
        } else {
          console.error(`  Checksum mismatch: ${migration.version} was applied with different content.`);
          writeResultArtifact({
            status: 'error',
            reasonCode: 'checksum-mismatch',
          });
          process.exit(1);
        }
      }

      const success = await executeMigration(executor, migration, env, force, dryRun);
      if (!success) {
        // Distinguish destructive-blocked (needs-human) from other validation failures
        const destructiveRe = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i;
        const isDestructive = !force && destructiveRe.test(migration.sql);
        if (isDestructive) {
          writeResultArtifact({
            status: 'needs-human',
            reasonCode: 'destructive-blocked',
            destructiveDetected: true,
          });
        } else {
          writeResultArtifact({
            status: 'validation-failed',
            reasonCode: 'sql-validation-failed',
          });
        }
        process.exit(1);
      }

      if (!dryRun) {
        await regenerateTypes(env);
      }

      console.error(`\n  Summary: ${migration.version} applied to ${env} ${dryRun ? '(dry run)' : 'successfully'}`);
      writeResultArtifact({
        status: 'applied',
        reasonCode: dryRun ? 'dry-run-validated' : 'migration-applied',
        appliedMigrations: [path.basename(filePath)],
        sideEffectsPerformed: dryRun
          ? ['no-side-effects']
          : ['migration-ledger-updated', 'types-regenerated'],
        nextActions: dryRun ? [] : ['regenerate-types'],
      });
    } finally {
      if (!dryRun) {
        await releaseLock(executor, env);
      }
    }
  } finally {
    await executor.close();
  }
}

main().catch((err) => {
  console.error(`  Migration failed: ${err.message}`);
  writeResultArtifact({
    status: 'error',
    reasonCode: 'unhandled-exception',
  });
  process.exit(1);
});
