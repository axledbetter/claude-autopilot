// src/core/migrate/types.ts

export interface InvocationEnvelope {
  contractVersion: '1.0';
  invocationId: string;
  /** 32-byte hex nonce, bound to subprocess identity for result-artifact authenticity */
  nonce: string;
  trigger: 'cli' | 'ci';
  attempt: number;
  repoRoot: string;
  cwd: string;
  changedFiles: string[];
  env: string;
  dryRun: boolean;
  ci: boolean;
  gitBase: string;
  gitHead: string;
  projectId?: string;
}

export type ResultStatus =
  | 'applied'
  | 'skipped'
  | 'validation-failed'
  | 'needs-human'
  | 'error';

export type SideEffect =
  | 'types-regenerated'
  | 'migration-ledger-updated'
  | 'schema-cache-refreshed'
  | 'seed-data-applied'
  | 'snapshot-written'
  | 'no-side-effects';

export interface ResultArtifact {
  contractVersion: '1.0';
  skillId: string;
  invocationId: string;
  /** Echoes the envelope nonce — mismatched value rejected by parser */
  nonce: string;
  status: ResultStatus;
  reasonCode: string;
  appliedMigrations: string[];
  destructiveDetected: boolean;
  sideEffectsPerformed: SideEffect[];
  nextActions: string[];
}

export interface SkillManifest {
  skillId: string;
  skill_runtime_api_version: string;
  min_runtime: string;
  max_runtime: string;
  stdoutFallback?: boolean;
}

export interface CommandSpec {
  exec: string;
  args: string[];
}

export interface AliasEntry {
  stableId: string;
  resolvesTo: string;
  rawAliases?: string[];
}
