import postgres from 'postgres';
import type { MigrationExecutor, ExecutionResult, EnvConfig } from './types';

export class PostgresExecutor implements MigrationExecutor {
  private sql: ReturnType<typeof postgres>;

  constructor(dbUrl: string) {
    this.sql = postgres(dbUrl, { ssl: 'require' });
  }

  async execute(sqlText: string): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      await this.sql.unsafe(sqlText);
      return { success: true, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, durationMs: Date.now() - start, error: err.message };
    }
  }

  async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const rows = await this.sql.unsafe(sqlText);
    return rows as unknown as T[];
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

export class ManagementApiExecutor implements MigrationExecutor {
  constructor(
    private projectId: string,
    private accessToken: string,
  ) {}

  async execute(sqlText: string): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const res = await fetch(
        `https://api.supabase.com/v1/projects/${this.projectId}/database/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: sqlText }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        return { success: false, durationMs: Date.now() - start, error: `HTTP ${res.status}: ${body}` };
      }
      return { success: true, durationMs: Date.now() - start };
    } catch (err: any) {
      return { success: false, durationMs: Date.now() - start, error: err.message };
    }
  }

  async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${this.projectId}/database/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sqlText }),
      },
    );
    if (!res.ok) throw new Error(`Query failed: HTTP ${res.status}`);
    return res.json();
  }

  async close(): Promise<void> {}
}

export function createExecutor(envConfig: EnvConfig, accessToken?: string): MigrationExecutor {
  // Prefer Management API (works without DB password, one token for all envs)
  const token = accessToken || process.env.SUPABASE_ACCESS_TOKEN;
  if (token) {
    return new ManagementApiExecutor(envConfig.projectId, token);
  }
  // Fallback to direct Postgres if dbUrl is configured
  if (envConfig.dbUrl) {
    return new PostgresExecutor(envConfig.dbUrl);
  }
  throw new Error('No executor available: set SUPABASE_ACCESS_TOKEN env var or add dbUrl to .claude/supabase-envs.json');
}
