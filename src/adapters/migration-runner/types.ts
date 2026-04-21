import type { AdapterBase } from '../base.ts';

export type MigrationEnv = 'dev' | 'qa' | 'prod';

export interface Migration {
  name: string;
  path: string;
  content?: string;
}

export interface DryRunResult {
  ok: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ApplyResult {
  ok: boolean;
  appliedSha?: string;
  durationMs?: number;
  errors?: string[];
}

export interface LedgerEntry {
  name: string;
  appliedAt: string;
  sha?: string;
}

export interface MigrationRunner extends AdapterBase {
  discover(touchedFiles: string[]): Migration[];
  dryRun(migration: Migration): Promise<DryRunResult>;
  apply(migration: Migration, env: MigrationEnv): Promise<ApplyResult>;
  ledger(env: MigrationEnv): Promise<LedgerEntry[]>;
  alreadyApplied(migration: Migration, env: MigrationEnv): Promise<boolean>;
}
