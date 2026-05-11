import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { detectProject, type DetectionResult } from './detector.ts';
import { runHook } from './hook.ts';
import { runDoctor } from './preflight.ts';
import { detectLLMKey, LLM_KEY_NAMES } from '../core/detect/llm-key.ts';
import { requirePackageRoot } from './_pkg-root.ts';

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
  'python': 'Python',
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
  const pkgRoot = requirePackageRoot(import.meta.url);
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

  console.log(`\n${BOLD('[setup]')} ${DIM(cwd)}\n`);
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
  // Only append testCommand if the preset doesn't already declare one — several
  // presets (go, python, python-fastapi, rails-postgres) ship with their own
  // testCommand line. Unconditionally appending produced duplicate YAML keys
  // ("testCommand" twice in the same map), which yaml parsers reject. After
  // 5.0.5 that broke `setup` on Python repos: every command after setup
  // hard-failed until the user manually edited the file.
  if (!/^testCommand\s*:/m.test(presetContent)) {
    presetContent = presetContent.trimEnd() + `\ntestCommand: "${detection.testCommand}"\n`;
  }

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

  // v7.1.7 — Auto-add `.guardrail-cache/` and `node_modules/` to .gitignore.
  // Per the v7.1.6 blank-repo benchmark, these are the two most common
  // day-1 paper cuts: `setup` creates the cache dir on first run, and (for
  // Node projects) `npm install` creates `node_modules` — neither belongs
  // in git. Skipped silently if already present or no .gitignore exists
  // and we don't want to create one without consent.
  const gitignoreAdds = await ensureGitignoreEntries(cwd, [
    '.guardrail-cache/',
    'node_modules/',
  ]);
  if (gitignoreAdds.length > 0) {
    console.log(`\n  ${PASS}  Added to .gitignore: ${DIM(gitignoreAdds.join(', '))}`);
  }

  // v7.1.7 — Auto-scaffold a starter CLAUDE.md if none exists. Closes ~5 of
  // 6 friction points the benchmark agent hit on a blank repo (commit
  // style, error class shape, test runner choice, etc.).
  const claudeMdAdded = await ensureStarterClaudeMd(cwd, detection);
  if (claudeMdAdded) {
    console.log(`  ${PASS}  Wrote starter CLAUDE.md`);
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

  // v7.1.9 — Generic+low-confidence detection prompt. The v7.1.8 benchmark
  // re-run on a truly blank repo (no package.json / go.mod / language signal)
  // surfaced this: setup runs fine but downstream agents get a CLAUDE.md
  // saying "Detected: Generic (low confidence)" with no concrete next step
  // to improve detection. Surfacing the actionable "scaffold a stack file
  // first" hint converts a paper-cut into a one-liner.
  if (detection.preset === 'generic' && detection.confidence === 'low') {
    console.log(`  ${WARN}  ${CYAN('Stack detection: Generic (low confidence).')}`);
    console.log(`       For higher-quality reviews + stack-specific presets, scaffold a`);
    console.log(`       package manifest first, then re-run setup:`);
    console.log(`         npm init -y                              ${DIM('# or: pnpm init, go mod init, cargo init')}`);
    console.log(`         npx claude-autopilot setup --force       ${DIM('# re-detect with the new manifest')}\n`);
  }

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

// ---------------------------------------------------------------------------
// v7.1.7 — setup-verb day-1 polish helpers
// ---------------------------------------------------------------------------

/**
 * Append `entries` to `<cwd>/.gitignore` if missing. Returns the entries
 * actually added (empty array when all already present, .gitignore is empty
 * + we don't want to create one, etc.).
 *
 * Behavior:
 *   - .gitignore exists: parse line-by-line, skip entries already present
 *     (exact match after trim, ignoring leading `!`), append the rest.
 *   - .gitignore missing: create it with the entries. Reasonable default
 *     for a fresh `setup` since the user is opting into autopilot's cache.
 *
 * Idempotent: safe to call twice with the same entries.
 */
export async function ensureGitignoreEntries(
  cwd: string,
  entries: string[],
): Promise<string[]> {
  const gitignorePath = path.join(cwd, '.gitignore');
  let existing: string[] = [];
  let existingContent = '';
  try {
    existingContent = await fsAsync.readFile(gitignorePath, 'utf8');
    existing = existingContent
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    // File doesn't exist — that's fine, we'll create it below.
  }

  const present = new Set(existing.map((l) => l.replace(/^!/, '')));
  const missing = entries.filter((e) => !present.has(e.replace(/^!/, '')));
  if (missing.length === 0) return [];

  // Build the appended block. Add a trailing newline first so we don't
  // collide with a no-final-newline file.
  const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
  const block =
    (needsLeadingNewline ? '\n' : '') +
    (existingContent.length > 0 ? '# claude-autopilot (v7.1.7+)\n' : '') +
    missing.join('\n') +
    '\n';
  await fsAsync.writeFile(gitignorePath, existingContent + block, 'utf8');
  return missing;
}

/**
 * Write a starter `<cwd>/CLAUDE.md` if none exists. Pulls stack-detection
 * info from the same `detection` result that drove preset selection, so the
 * scaffolded conventions match the actual project.
 *
 * The starter doc is intentionally short (~35 lines) — a real project will
 * grow it. The goal is to give downstream agents an anchor for the most
 * common "I had to guess" decisions the v7.1.6 benchmark agent reported:
 * commit-message style, test command, error class shape, prompt location.
 *
 * Returns true when the file was written (false if it already exists; we
 * never overwrite — operator opted into autopilot, not into us nuking
 * their docs).
 */
export async function ensureStarterClaudeMd(
  cwd: string,
  detection: DetectionResult,
): Promise<boolean> {
  const dest = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(dest)) return false;

  const stackLabel = PRESET_LABELS[detection.preset] ?? detection.preset;
  const today = new Date().toISOString().slice(0, 10);
  const body = [
    `# CLAUDE.md`,
    ``,
    `Project conventions for AI-assisted contributions. Auto-scaffolded by`,
    `\`claude-autopilot setup\` on ${today}; edit freely.`,
    ``,
    `## Stack`,
    ``,
    `- **Detected:** ${stackLabel} (${detection.confidence} confidence)`,
    `- **Test command:** \`${detection.testCommand}\``,
    `- **Evidence:** ${detection.evidence}`,
    ``,
    `## Conventions`,
    ``,
    `- **Commit messages:** Conventional Commits (\`feat:\`, \`fix:\`,`,
    `  \`docs:\`, \`refactor:\`, \`test:\`, \`chore:\`). One sentence first`,
    `  line, optional body.`,
    `- **Branches:** \`feat/<topic>\`, \`fix/<topic>\`, \`chore/<topic>\`.`,
    `- **Errors:** prefer custom \`Error\` subclasses with a string \`code\``,
    `  field for programmatic handling. Example:`,
    `  \`\`\`ts`,
    `  class FetchFailed extends Error { code = 'fetch_failed' as const; }`,
    `  \`\`\``,
    `- **Tests:** colocated with source under \`tests/\` or \`__tests__/\`.`,
    `  Run via \`${detection.testCommand}\`.`,
    ``,
    `## Patterns to mimic`,
    ``,
    `- TODO: as the project grows, list 2-3 example files agents should`,
    `  read first to learn local style.`,
    ``,
    `## Common pitfalls`,
    ``,
    `- TODO: list any non-obvious gotchas — env-var quirks, ordering`,
    `  requirements, footguns the test suite won't catch.`,
    ``,
  ].join('\n');
  await fsAsync.writeFile(dest, body, 'utf8');
  return true;
}
