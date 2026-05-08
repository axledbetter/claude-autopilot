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
 * Phase 4 — resolve the dashboard / public base URL from env, with
 * AUTOPILOT_PUBLIC_BASE_URL preferred and AUTOPILOT_DASHBOARD_BASE_URL
 * accepted as a deprecated alias. Logs a one-time deprecation warning
 * when only the older variable is set.
 *
 * Defaults to https://autopilot.dev when neither is present.
 */
let _deprecationWarned = false;

export function getAutopilotBaseUrl(): string {
  const canonical = process.env.AUTOPILOT_PUBLIC_BASE_URL;
  const legacy = process.env.AUTOPILOT_DASHBOARD_BASE_URL;
  if (canonical) return canonical;
  if (legacy) {
    if (!_deprecationWarned) {
      _deprecationWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[autopilot] AUTOPILOT_DASHBOARD_BASE_URL is deprecated; ' +
        'use AUTOPILOT_PUBLIC_BASE_URL instead. Both are accepted for now.',
      );
    }
    return legacy;
  }
  return 'https://autopilot.dev';
}

// Test seam — reset the one-shot warning flag.
export function _resetAutopilotBaseUrlWarning(): void {
  _deprecationWarned = false;
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
