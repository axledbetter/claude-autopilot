import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AllEnvConfig, Environment, MigrationFile } from './types';

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), '.claude', 'supabase-envs.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): AllEnvConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing Supabase config: ${configPath}\nCreate .claude/supabase-envs.json with dev/qa/prod credentials.`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as AllEnvConfig;
}

export function getAccessToken(): string {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('SUPABASE_ACCESS_TOKEN not set. Get one from https://supabase.com/dashboard/account/tokens');
  }
  return token;
}

export function extractVersion(filePath: string): string {
  return path.basename(filePath, '.sql');
}

export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function loadMigrationFile(filePath: string): MigrationFile {
  const sql = fs.readFileSync(filePath, 'utf8');
  return {
    path: filePath,
    version: extractVersion(filePath),
    checksum: computeChecksum(sql),
    sql,
  };
}

export function getPromotionSource(target: Environment): Environment {
  if (target === 'qa') return 'dev';
  if (target === 'prod') return 'qa';
  throw new Error(`Cannot promote to ${target} — no source env defined`);
}
