#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSafe } from '../core/shell.ts';
import { detectLLMKey, loadEnvFile, LLM_KEY_NAMES } from '../core/detect/llm-key.ts';
import { findPackageRoot } from './_pkg-root.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const ENV_CANDIDATES = ['.env.local', '.env.dev', '.env.development', '.env'];

interface Check {
  name: string;
  result: 'pass' | 'fail' | 'warn';
  message?: string;
}

export interface DoctorResult {
  blockers: number;
  warnings: number;
}

/**
 * Checks that the superpowers plugin skills required by the pipeline are resolvable
 * from the usual Claude Code plugin paths. Returns skill names that weren't found.
 */
const REQUIRED_SUPERPOWERS_SKILLS = [
  'writing-plans',
  'using-git-worktrees',
  'subagent-driven-development',
] as const;

function skillRoots(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cwd = process.cwd();
  const roots: string[] = [];
  // Project-local plugin install
  roots.push(path.join(cwd, '.claude', 'plugins'));
  // User-global plugin install
  if (home) roots.push(path.join(home, '.claude', 'plugins'));
  return roots.filter(p => fs.existsSync(p));
}

export function findMissingSuperpowersSkills(): string[] {
  // Traverse each root once, collect all discovered skill names, then diff against
  // the required set. Previous implementation did N × roots separate recursive walks.
  const discovered = new Set<string>();
  const MAX_DIRS_PER_ROOT = 2000; // safety cap to prevent pathological plugin trees

  for (const root of skillRoots()) {
    collectSkills(root, discovered, { visited: { n: 0 }, max: MAX_DIRS_PER_ROOT });
  }

  return REQUIRED_SUPERPOWERS_SKILLS.filter(s => !discovered.has(s));
}

// Walks up to 8 levels deep, capped at `max` directories total. When it finds a
// `skills/` directory, records every `<skill-name>/SKILL.md` and `<skill-name>.md`
// entry directly into the Set. Never revisits by name (Claude Code plugin caches
// can contain many parallel copies — we only care whether a skill exists *somewhere*).
function collectSkills(
  dir: string,
  out: Set<string>,
  ctx: { visited: { n: number }; max: number },
  depth = 0,
): void {
  if (depth > 8) return;
  if (ctx.visited.n >= ctx.max) return;
  ctx.visited.n++;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // If this dir has a skills/ child, record every skill inside it
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'skills') {
      const skillsDir = path.join(dir, 'skills');
      try {
        for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (skill.isDirectory() && fs.existsSync(path.join(skillsDir, skill.name, 'SKILL.md'))) {
            out.add(skill.name);
          } else if (skill.isFile() && skill.name.endsWith('.md') && skill.name !== 'README.md') {
            out.add(skill.name.slice(0, -3)); // strip .md
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Recurse into non-skills dirs (bounded depth + visit cap prevent pathological scans)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name === 'skills') continue; // already handled above
    collectSkills(path.join(dir, entry.name), out, ctx, depth + 1);
  }
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

  // 2. tsx available — checked in three places, in order:
  //   a) consumer project: <cwd>/node_modules/.bin/tsx
  //   b) this package's own bundled tsx (covers global installs — the package
  //      ships its own node_modules; bin/_launcher.js uses the same lookup)
  //   c) PATH fallback
  // Previous version only checked (a) + (c), which false-positive-failed every
  // global install since (b) is where tsx actually lives there.
  const pkgRoot = findPackageRoot(import.meta.url);
  const ownTsx = pkgRoot ? path.join(pkgRoot, 'node_modules', '.bin', 'tsx') : null;
  const localTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const tsxVersion = fs.existsSync(localTsx)
    ? runSafe(localTsx, ['--version'])
    : ownTsx && fs.existsSync(ownTsx)
      ? runSafe(ownTsx, ['--version'])
      : runSafe('tsx', ['--version']);
  checks.push({
    name: 'tsx available',
    result: tsxVersion ? 'pass' : 'fail',
    message: !tsxVersion
      ? 'tsx not found — reinstall: npm install -g @delegance/claude-autopilot@latest'
      : undefined,
  });

  // 3. gh CLI authenticated
  const ghAuth = runSafe('gh', ['auth', 'status']);
  checks.push({
    name: 'gh CLI authenticated',
    result: ghAuth !== null ? 'pass' : 'fail',
    message: ghAuth === null ? 'gh CLI not authenticated — run: gh auth login' : undefined,
  });

  // 4. guardrail.config.yaml in cwd
  const configYaml = path.join(process.cwd(), 'guardrail.config.yaml');
  checks.push({
    name: 'guardrail.config.yaml',
    result: fs.existsSync(configYaml) ? 'pass' : 'warn',
    message: !fs.existsSync(configYaml)
      ? 'guardrail.config.yaml not found in current directory — copy from a preset: presets/nextjs-supabase/guardrail.config.yaml'
      : undefined,
  });

  // 5. Local env file exists
  const envFile = ENV_CANDIDATES.find(f => fs.existsSync(f));
  checks.push({
    name: `Local env file (${envFile ?? 'none found'})`,
    result: envFile ? 'pass' : 'warn',
    message: !envFile
      ? `No env file found. Looked for: ${ENV_CANDIDATES.join(', ')}. Create one with one of: ${LLM_KEY_NAMES.join(', ')}.`
      : undefined,
  });

  // 6. LLM API key — shared detection with setup/scan/run (all 5 providers)
  const envVars = envFile ? loadEnvFile(envFile) : {};
  const { hasKey, preferred } = detectLLMKey({ extraEnv: envVars });
  checks.push({
    name: `LLM API key (${preferred ?? 'none'})`,
    result: hasKey ? 'pass' : 'warn',
    message: !hasKey
      ? `No LLM API key found — set one of: ${LLM_KEY_NAMES.join(', ')} to enable review`
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

  // 9. Superpowers plugin — required for pipeline phases, optional for review-only use
  const missingSkills = findMissingSuperpowersSkills();
  const allSkillsFound = missingSkills.length === 0;
  checks.push({
    name: `Superpowers plugin${allSkillsFound ? '' : ` (missing: ${missingSkills.join(', ')})`}`,
    // Treat as warn, not fail — users who only run `claude-autopilot run` (review phase)
    // don't need superpowers. Pipeline invocations (`autopilot` skill) will hard-fail at
    // their own entry point.
    result: allSkillsFound ? 'pass' : 'warn',
    message: !allSkillsFound
      ? 'Install: `claude plugin install superpowers` (required for pipeline phases — brainstorm/plan/implement)'
      : undefined,
  });

  // Print results
  console.log('\n\x1b[1m[doctor] claude-autopilot prerequisite check\x1b[0m\n');
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
    console.log(`\x1b[31m[doctor] ${blockers} blocker(s) — fix before running claude-autopilot run\x1b[0m\n`);
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
