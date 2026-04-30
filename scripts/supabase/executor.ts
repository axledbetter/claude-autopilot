import { URL } from 'node:url';
import postgres from 'postgres';
import type { MigrationExecutor, ExecutionResult, EnvConfig } from './types';

/**
 * Decide the postgres-js `ssl` option from the connection URL.
 *
 * Honors the standard libpq `sslmode` query param when set; otherwise
 * defaults to SSL only for non-localhost hosts. Local dev postgres
 * (e.g. docker compose) usually has no SSL configured, so hardcoding
 * `ssl: 'require'` made local dev unusable.
 *
 * Returns:
 *   - 'require'  — strict SSL (sslmode=require/verify-full/verify-ca, or remote default)
 *   - false      — no SSL  (sslmode=disable, or localhost default)
 */
export function shouldUseSsl(dbUrl: string): 'require' | false {
  try {
    const u = new URL(dbUrl);
    const sslmode = u.searchParams.get('sslmode');
    if (sslmode === 'require' || sslmode === 'verify-full' || sslmode === 'verify-ca') {
      return 'require';
    }
    if (sslmode === 'disable' || sslmode === 'allow' || sslmode === 'prefer') {
      return false;
    }
    // Default: SSL for non-localhost only
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? false : 'require';
  } catch {
    return false;
  }
}

export class PostgresExecutor implements MigrationExecutor {
  private sql: ReturnType<typeof postgres>;

  constructor(dbUrl: string) {
    this.sql = postgres(dbUrl, { ssl: shouldUseSsl(dbUrl) });
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
