export type Environment = 'dev' | 'qa' | 'prod';

export interface EnvConfig {
  projectId: string;
  url: string;
  serviceRoleKey: string;
  dbUrl: string;
}

export interface AllEnvConfig {
  dev: EnvConfig;
  qa: EnvConfig;
  prod: EnvConfig;
}

export interface MigrationExecutor {
  execute(sql: string): Promise<ExecutionResult>;
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

export interface ExecutionResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface Finding {
  check: string;
  severity: 'error' | 'warn' | 'block';
  message: string;
  file?: string;
  line?: number;
}

export interface ValidationResult {
  passed: boolean;
  errors: Finding[];
  warnings: Finding[];
}

export interface LedgerRow {
  id: number;
  version: string;
  checksum: string;
  environment: string;
  applied_at: string;
  applied_by: string;
  success: boolean;
  execution_ms: number | null;
  error_message: string | null;
}

export interface MigrationFile {
  path: string;
  version: string;
  checksum: string;
  sql: string;
}
