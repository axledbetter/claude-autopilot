import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSafe } from '../../core/shell.ts';
import type { Capabilities } from '../base.ts';
import type { MigrationRunner, Migration, MigrationEnv, DryRunResult, ApplyResult, LedgerEntry } from './types.ts';

export const supabaseAdapter: MigrationRunner = {
  name: 'supabase',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: false, streaming: false, maxContextTokens: 0, inlineComments: false };
  },

  discover(touchedFiles: string[]): Migration[] {
    const sqlFiles = touchedFiles.filter(f => f.match(/data\/deltas\/[^/]+\.sql$/));
    return sqlFiles.map(p => ({
      name: path.basename(p, '.sql'),
      path: p,
    }));
  },

  async dryRun(migration: Migration): Promise<DryRunResult> {
    try {
      const content = migration.content ?? fs.readFileSync(migration.path, 'utf8');
      if (!content.trim()) return { ok: false, errors: ['Migration file is empty'] };
      return { ok: true };
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
  },

  async apply(migration: Migration, env: MigrationEnv): Promise<ApplyResult> {
    const start = Date.now();
    const envFlag = env === 'prod' ? '--prod' : env === 'qa' ? '--qa' : '';
    const args = ['tsx', 'scripts/supabase/migrate.ts', migration.path];
    if (envFlag) args.push(envFlag);
    const result = runSafe('npx', args);
    if (result === null) {
      return { ok: false, errors: [`Migration apply failed for ${migration.name} on ${env}`] };
    }
    return { ok: true, durationMs: Date.now() - start };
  },

  async ledger(_env: MigrationEnv): Promise<LedgerEntry[]> {
    // alpha.1: full ledger query lands in alpha.2
    return [];
  },

  async alreadyApplied(migration: Migration, _env: MigrationEnv): Promise<boolean> {
    const result = runSafe('npx', ['tsx', 'scripts/supabase/migrate.ts', migration.path, '--inspect']);
    return result !== null && result.includes('already applied');
  },
};

export default supabaseAdapter;
