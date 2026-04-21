#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSafe } from '../core/shell.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const ENV_CANDIDATES = ['.env.local', '.env.dev', '.env.development', '.env'];

interface Check {
  name: string;
  result: 'pass' | 'fail' | 'warn';
  message?: string;
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

export interface DoctorResult {
  blockers: number;
  warnings: number;
}

export async function runDoctor(): Promise<DoctorResult> {
  const checks: Check[] = [];

  // 1. Node version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0]!, 10);
  checks.push({
    name: `Node.js ${nodeVersion}`,
    result: nodeMajor >= 22 ? 'pass' : 'fail',
    message: nodeMajor < 22 ? `Node 22+ required — current: ${nodeVersion}. Install via nvm: nvm install 22` : undefined,
  });

  // 2. tsx available
  const localTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const tsxVersion = fs.existsSync(localTsx)
    ? runSafe(localTsx, ['--version'])
    : runSafe('tsx', ['--version']);
  checks.push({
    name: 'tsx available',
    result: tsxVersion ? 'pass' : 'fail',
    message: !tsxVersion ? 'tsx not found — run: npm install @delegance/claude-autopilot (includes tsx)' : undefined,
  });

  // 3. gh CLI authenticated
  const ghAuth = runSafe('gh', ['auth', 'status']);
  checks.push({
    name: 'gh CLI authenticated',
    result: ghAuth !== null ? 'pass' : 'fail',
    message: ghAuth === null ? 'gh CLI not authenticated — run: gh auth login' : undefined,
  });

  // 4. autopilot.config.yaml in cwd
  const configYaml = path.join(process.cwd(), 'autopilot.config.yaml');
  checks.push({
    name: 'autopilot.config.yaml',
    result: fs.existsSync(configYaml) ? 'pass' : 'warn',
    message: !fs.existsSync(configYaml)
      ? 'autopilot.config.yaml not found in current directory — copy from a preset: presets/nextjs-supabase/autopilot.config.yaml'
      : undefined,
  });

  // 5. Local env file exists
  const envFile = ENV_CANDIDATES.find(f => fs.existsSync(f));
  checks.push({
    name: `Local env file (${envFile ?? 'none found'})`,
    result: envFile ? 'pass' : 'warn',
    message: !envFile
      ? `No env file found. Looked for: ${ENV_CANDIDATES.join(', ')}. Create one with your OPENAI_API_KEY.`
      : undefined,
  });

  // 6. OPENAI_API_KEY set
  const envVars = envFile ? loadEnvFile(envFile) : {};
  const hasOpenAI = !!process.env.OPENAI_API_KEY || !!envVars['OPENAI_API_KEY'];
  checks.push({
    name: 'OPENAI_API_KEY',
    result: hasOpenAI ? 'pass' : 'warn',
    message: !hasOpenAI
      ? `OPENAI_API_KEY not set — Codex review steps will be skipped`
      : undefined,
  });

  // 7. claude CLI available
  const claudeVersion = runSafe('claude', ['--version']);
  checks.push({
    name: 'claude CLI',
    result: claudeVersion ? 'pass' : 'fail',
    message: !claudeVersion
      ? 'claude CLI not found — required for autofix. Install Claude Code: https://claude.ai/claude-code'
      : undefined,
  });

  // 8. git user config
  const gitName = runSafe('git', ['config', 'user.name']);
  const gitEmail = runSafe('git', ['config', 'user.email']);
  const gitConfigOk = !!(gitName?.trim()) && !!(gitEmail?.trim());
  checks.push({
    name: 'git user config',
    result: gitConfigOk ? 'pass' : 'warn',
    message: !gitConfigOk
      ? 'git user.name / user.email not set — commits will fail.'
      : undefined,
  });

  // 9. superpowers plugin
  const home = process.env.HOME ?? '';
  const superpowersPaths = [
    path.join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers'),
    path.join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'superpowers'),
    path.join(home, '.claude', 'plugins', 'superpowers'),
  ];
  const superpowersOk = superpowersPaths.some(p => fs.existsSync(p));
  checks.push({
    name: 'superpowers plugin',
    result: superpowersOk ? 'pass' : 'warn',
    message: !superpowersOk
      ? 'superpowers plugin not detected — install: /plugin install superpowers@claude-plugins-official'
      : undefined,
  });

  // Print results
  console.log('\n\x1b[1m[doctor] Autopilot prerequisite check\x1b[0m\n');
  let blockers = 0;
  let warnings = 0;
  for (const check of checks) {
    const icon = check.result === 'pass' ? PASS : check.result === 'warn' ? WARN : FAIL;
    console.log(`  ${icon}  ${check.name}`);
    if (check.message) {
      console.log(`       \x1b[2m${check.message}\x1b[0m`);
    }
    if (check.result === 'fail') blockers++;
    if (check.result === 'warn') warnings++;
  }

  console.log('');
  if (blockers > 0) {
    console.log(`\x1b[31m[doctor] ${blockers} blocker(s) — fix before running npx autopilot run\x1b[0m\n`);
  } else if (warnings > 0) {
    console.log(`\x1b[33m[doctor] ${warnings} warning(s) — pipeline will run but some steps may be skipped\x1b[0m\n`);
  } else {
    console.log(`\x1b[32m[doctor] All checks passed — ready to run\x1b[0m\n`);
  }

  return { blockers, warnings };
}

// Run when invoked directly
const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runDoctor().then(r => process.exit(r.blockers > 0 ? 1 : 0));
}
