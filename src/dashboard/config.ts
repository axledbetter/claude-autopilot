// CLI dashboard config — atomic read/write of ~/.claude-autopilot/dashboard.json.
//
// Codex plan-pass WARNING: respect CLAUDE_AUTOPILOT_HOME env override so
// tests + experimentation never touch the developer's real home dir.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DashboardConfig {
  schemaVersion: 1;
  apiKey: string;
  fingerprint: string;
  accountEmail: string;
  loggedInAt: string;
  lastUploadAt: string | null;
}

const KEY_RE = /^clp_[0-9a-f]{64}$/;

function resolveHome(): string {
  return process.env.CLAUDE_AUTOPILOT_HOME ?? path.join(os.homedir(), '.claude-autopilot');
}

export function getConfigDir(): string {
  return resolveHome();
}

export function getConfigPath(): string {
  return path.join(resolveHome(), 'dashboard.json');
}

export async function readConfig(): Promise<DashboardConfig | null> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as DashboardConfig;
    if (parsed.schemaVersion !== 1) return null;
    if (!KEY_RE.test(parsed.apiKey)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeConfig(config: DashboardConfig): Promise<void> {
  if (!KEY_RE.test(config.apiKey)) {
    throw new Error('writeConfig: invalid apiKey shape');
  }
  const dir = getConfigDir();
  const file = getConfigPath();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Try to tighten dir mode even if it already existed.
  try { await fs.chmod(dir, 0o700); } catch { /* best effort */ }

  // Atomic write: temp-file + rename.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(config, null, 2);
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(getConfigPath());
  } catch {
    /* idempotent */
  }
}

/**
 * Returns a warning string if the config file is group/world-readable on
 * a POSIX filesystem; null otherwise (or on Windows, where mode bits
 * don't apply meaningfully).
 */
export async function warnIfPermissive(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const file = getConfigPath();
  try {
    const stat = await fs.stat(file);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `Warning: ${file} mode is ${mode.toString(8)} (group/world readable). Run: chmod 600 ${file}`;
    }
  } catch {
    /* file doesn't exist, no warning */
  }
  return null;
}
