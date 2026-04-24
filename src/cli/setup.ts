import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './detector.ts';
import { runHook } from './hook.ts';
import { runDoctor } from './preflight.ts';
import { detectLLMKey, LLM_KEY_NAMES } from '../core/detect/llm-key.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM  = (t: string) => `\x1b[2m${t}\x1b[0m`;
const BOLD = (t: string) => `\x1b[1m${t}\x1b[0m`;
const CYAN = (t: string) => `\x1b[36m${t}\x1b[0m`;

const PRESET_LABELS: Record<string, string> = {
  'nextjs-supabase': 'Next.js + Supabase',
  't3': 'T3 Stack (Next.js + tRPC + Prisma)',
  'rails-postgres': 'Ruby on Rails + PostgreSQL',
  'python-fastapi': 'Python FastAPI',
  'go': 'Go + PostgreSQL',
  'generic': 'Generic (no stack-specific assumptions)',
};

export type ProfileName = 'security-strict' | 'team' | 'solo';

const PROFILES: Record<ProfileName, { label: string; overlay: string }> = {
  'security-strict': {
    label: 'Security Strict',
    overlay: [
      'staticRules:',
      '  - hardcoded-secrets',
      '  - npm-audit',
      '  - package-lock-sync',
      '  - sql-injection',
      '  - missing-auth',
      '  - ssrf',
      '  - insecure-redirect',
      'policy:',
      '  failOn: warning',
      '  newOnly: false',
    ].join('\n'),
  },
  'team': {
    label: 'Team',
    overlay: [
      'staticRules:',
      '  - hardcoded-secrets',
      '  - npm-audit',
      '  - package-lock-sync',
      '  - sql-injection',
      '  - missing-auth',
      '  - ssrf',
      '  - insecure-redirect',
      'policy:',
      '  failOn: critical',
      '  newOnly: false',
    ].join('\n'),
  },
  'solo': {
    label: 'Solo Dev',
    overlay: [
      'staticRules:',
      '  - hardcoded-secrets',
      '  - npm-audit',
      'policy:',
      '  failOn: critical',
      '  newOnly: false',
    ].join('\n'),
  },
};

export interface SetupOptions {
  cwd?: string;
  force?: boolean;
  skipHook?: boolean;
  profile?: ProfileName;
}

function presetSearchPaths(name: string, cwd: string): string[] {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return [
    path.join(pkgRoot, 'presets', name, 'guardrail.config.yaml'),
    path.join(cwd, 'node_modules', '@delegance', 'claude-autopilot', 'presets', name, 'guardrail.config.yaml'),
  ];
}

function findPresetConfig(name: string, cwd: string): string | null {
  for (const p of presetSearchPaths(name, cwd)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const dest = path.join(cwd, 'guardrail.config.yaml');

  if (fs.existsSync(dest) && !options.force) {
    throw new Error('guardrail.config.yaml already exists — use --force to overwrite');
  }

  console.log(`\n${BOLD('[guardrail setup]')} ${DIM(cwd)}\n`);
  console.log(`${BOLD('Detecting project…')}\n`);

  const detection = detectProject(cwd);
  const label = PRESET_LABELS[detection.preset] ?? detection.preset;

  if (detection.confidence === 'high') {
    console.log(`  ${PASS}  Stack:        ${label}`);
    console.log(`  ${PASS}  Evidence:     ${DIM(detection.evidence)}`);
  } else {
    console.log(`  ${WARN}  Stack:        ${label} ${DIM('(low confidence — fallback preset)')}`);
    console.log(`       ${DIM(detection.evidence)}`);
    console.log(`       ${DIM('Edit guardrail.config.yaml to switch presets if needed')}`);
  }
  console.log(`  ${PASS}  Test command: ${DIM(detection.testCommand)}`);

  const { hasKey, preferred } = detectLLMKey();
  if (hasKey) {
    console.log(`  ${PASS}  LLM API key:  detected (${preferred})`);
  } else {
    console.log(`  ${WARN}  LLM API key:  not found`);
    console.log(`       ${DIM(`Set one of: ${LLM_KEY_NAMES.join(', ')}`)}`);
  }

  const presetConfigPath = findPresetConfig(detection.preset, cwd);
  if (!presetConfigPath) {
    throw new Error(`Preset config not found for: ${detection.preset}. Looked in:\n  ${presetSearchPaths(detection.preset, cwd).join('\n  ')}`);
  }

  let presetContent = await fsAsync.readFile(presetConfigPath, 'utf8');
  presetContent = presetContent.trimEnd() + `\ntestCommand: "${detection.testCommand}"\n`;

  // Apply profile overlay if specified
  if (options.profile) {
    const profile = PROFILES[options.profile];
    if (profile) {
      console.log(`  ${PASS}  Profile:      ${profile.label}`);
      // Profile overlay replaces staticRules + policy sections from preset
      presetContent = presetContent
        .replace(/^staticRules:.*?(?=^\w|\z)/ms, '')
        .replace(/^policy:.*?(?=^\w|\z)/ms, '');
      presetContent = presetContent.trimEnd() + `\n${profile.overlay}\n`;
    }
  }

  await fsAsync.writeFile(dest, presetContent, 'utf8');

  console.log(`\n${BOLD('Config written to guardrail.config.yaml:')}\n`);
  for (const line of presetContent.trimEnd().split('\n')) {
    console.log(`  ${DIM(line)}`);
  }

  let hookInstalled = false;
  if (!options.skipHook) {
    const hookCode = await runHook('install', { cwd, silent: true });
    hookInstalled = hookCode === 0;
    if (hookInstalled) {
      console.log(`\n  ${PASS}  Pre-push git hook installed`);
    } else {
      console.log(`\n  ${WARN}  Hook install failed (run: npx guardrail hook install)`);
    }
  }

  console.log('\nChecking prerequisites…');
  await runDoctor();

  console.log(`\n${BOLD('Next steps:')}\n`);
  if (!hasKey) {
    console.log(`  1. ${CYAN('Set an LLM API key')} — guardrail needs one to review code:`);
    console.log(`       export ANTHROPIC_API_KEY=sk-ant-...     # https://console.anthropic.com/`);
    console.log(`       export OPENAI_API_KEY=sk-...            # https://platform.openai.com/api-keys`);
    console.log(`       export GROQ_API_KEY=gsk_...             # https://console.groq.com/keys (free)\n`);
    console.log(`  2. ${CYAN('Review your changes:')}`);
    console.log(`       npx guardrail run --base main\n`);
    console.log(`  3. ${CYAN('Scan any path directly:')}`);
    console.log(`       npx guardrail scan src/auth/\n`);
  } else {
    console.log(`  ${CYAN('Review git-changed files:')}`);
    console.log(`    npx guardrail run --base main\n`);
    console.log(`  ${CYAN('Scan any path (no git needed):')}`);
    console.log(`    npx guardrail scan src/auth/\n`);
    console.log(`  ${CYAN('Ask a targeted question:')}`);
    console.log(`    npx guardrail scan --ask "is there SQL injection here?" src/db/\n`);
    if (!hookInstalled && !options.skipHook) {
      console.log(`  ${CYAN('Install pre-push hook (auto-runs before git push):')}`);
      console.log(`    npx guardrail hook install\n`);
    }
  }
}
