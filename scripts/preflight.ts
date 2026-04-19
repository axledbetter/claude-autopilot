#!/usr/bin/env tsx
/**
 * Preflight check — run before the autopilot pipeline.
 * Exits 0 if everything is ready. Exits 1 and prints actionable errors if not.
 * Fast: no network calls, no package installs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const ENV_CANDIDATES = ['.env.local', '.env.dev', '.env.development', '.env'];

interface Check {
  name: string;
  result: 'pass' | 'fail' | 'warn';
  message?: string;
}

function runSafe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
  } catch {
    return null;
  }
}

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* ignore */ }
  return vars;
}

const checks: Check[] = [];

// 1. Node version
const nodeVersion = process.version; // e.g. "v22.1.0"
const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
checks.push({
  name: `Node.js ${nodeVersion}`,
  result: nodeMajor >= 22 ? 'pass' : 'fail',
  message: nodeMajor < 22 ? `Node 22+ required — current: ${nodeVersion}. Install via nvm: nvm install 22` : undefined,
});

// 2. tsx available
const tsxVersion = runSafe('npx', ['tsx', '--version']);
checks.push({
  name: 'tsx available',
  result: tsxVersion ? 'pass' : 'fail',
  message: !tsxVersion ? 'tsx not found — run: npm install --save-dev tsx' : undefined,
});

// 3. gh CLI authenticated
const ghAuth = runSafe('gh', ['auth', 'status']);
checks.push({
  name: 'gh CLI authenticated',
  result: ghAuth !== null ? 'pass' : 'fail',
  message: ghAuth === null ? 'gh CLI not authenticated — run: gh auth login' : undefined,
});

// 4. Local env file exists
const envFile = ENV_CANDIDATES.find(f => fs.existsSync(f));
checks.push({
  name: `Local env file (${envFile ?? 'none found'})`,
  result: envFile ? 'pass' : 'warn',
  message: !envFile
    ? `No env file found. Looked for: ${ENV_CANDIDATES.join(', ')}. Create one with your OPENAI_API_KEY and other secrets.`
    : undefined,
});

// 5. OPENAI_API_KEY set (needed for Codex review)
const envVars = envFile ? loadEnvFile(envFile) : {};
const hasOpenAI = !!process.env.OPENAI_API_KEY || !!envVars['OPENAI_API_KEY'];
checks.push({
  name: 'OPENAI_API_KEY',
  result: hasOpenAI ? 'pass' : 'warn',
  message: !hasOpenAI
    ? `OPENAI_API_KEY not set in ${envFile ?? 'any env file'} — Codex review steps will be skipped`
    : undefined,
});

// 6. .autopilot/stack.md exists (Codex review context)
const stackMd = path.join(process.cwd(), '.autopilot', 'stack.md');
checks.push({
  name: '.autopilot/stack.md',
  result: fs.existsSync(stackMd) ? 'pass' : 'warn',
  message: !fs.existsSync(stackMd)
    ? 'Missing .autopilot/stack.md — Codex reviews will use a generic stack description. Copy .autopilot/stack.md.example and fill it in.'
    : undefined,
});

// 7. superpowers plugin installed
const pluginDir = path.join(process.env.HOME ?? '', '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers');
const superpowersOk = fs.existsSync(pluginDir);
checks.push({
  name: 'superpowers plugin',
  result: superpowersOk ? 'pass' : 'fail',
  message: !superpowersOk
    ? 'superpowers plugin not found — install via Claude Code: /plugin install superpowers@claude-plugins-official'
    : undefined,
});

// Print results
console.log('\n\x1b[1m[preflight] Autopilot prerequisite check\x1b[0m\n');
let failures = 0;
let warnings = 0;
for (const check of checks) {
  const icon = check.result === 'pass' ? PASS : check.result === 'warn' ? WARN : FAIL;
  console.log(`  ${icon}  ${check.name}`);
  if (check.message) {
    console.log(`       \x1b[2m${check.message}\x1b[0m`);
  }
  if (check.result === 'fail') failures++;
  if (check.result === 'warn') warnings++;
}

console.log('');
if (failures > 0) {
  console.log(`\x1b[31m[preflight] ${failures} check(s) failed — fix the above before running /autopilot\x1b[0m\n`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\x1b[33m[preflight] ${warnings} warning(s) — pipeline will run but some steps may be degraded\x1b[0m\n`);
} else {
  console.log(`\x1b[32m[preflight] All checks passed\x1b[0m\n`);
}
