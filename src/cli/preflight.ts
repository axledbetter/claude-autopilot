#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSafe } from '../core/shell.ts';
import { detectLLMKey, loadEnvFile, LLM_KEY_NAMES } from '../core/detect/llm-key.ts';

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
  const missing: string[] = [];
  const roots = skillRoots();
  for (const skill of REQUIRED_SUPERPOWERS_SKILLS) {
    const found = roots.some(root => recursiveSkillSearch(root, skill));
    if (!found) missing.push(skill);
  }
  return missing;
}

// Walks up to 8 levels deep looking for `skills/<skill>/SKILL.md` or `skills/<skill>.md`.
// Plugin paths vary: marketplace cache, cache/temp_git_*, installed_plugins, etc.
function recursiveSkillSearch(dir: string, skill: string, depth = 0): boolean {
  if (depth > 8) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  // Shortcut: if current dir has a `skills/` child, check it directly first
  const skillsDir = entries.find(e => e.isDirectory() && e.name === 'skills');
  if (skillsDir) {
    const dirPath = path.join(dir, 'skills', skill, 'SKILL.md');
    const filePath = path.join(dir, 'skills', `${skill}.md`);
    if (fs.existsSync(dirPath) || fs.existsSync(filePath)) return true;
  }
  // Recurse into non-skills dirs (bounded depth prevents pathological traversal)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    if (recursiveSkillSearch(path.join(dir, entry.name), skill, depth + 1)) return true;
  }
  return false;
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
    message: !tsxVersion ? 'tsx not found — run: npm install @delegance/guardrail (includes tsx)' : undefined,
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
  console.log('\n\x1b[1m[doctor] Guardrail prerequisite check\x1b[0m\n');
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
    console.log(`\x1b[31m[doctor] ${blockers} blocker(s) — fix before running npx guardrail run\x1b[0m\n`);
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
