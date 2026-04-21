import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './detector.ts';
import { runHook } from './hook.ts';
import { runDoctor } from './preflight.ts';

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const PRESET_LABELS: Record<string, string> = {
  'nextjs-supabase': 'Next.js + Supabase',
  't3': 'T3 Stack (Next.js + tRPC + Prisma)',
  'rails-postgres': 'Ruby on Rails + PostgreSQL',
  'python-fastapi': 'Python FastAPI',
  'go': 'Go + PostgreSQL',
};

export interface SetupOptions {
  cwd?: string;
  force?: boolean;
  skipHook?: boolean;
}

function presetSearchPaths(name: string, cwd: string): string[] {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return [
    path.join(pkgRoot, 'presets', name, 'autopilot.config.yaml'),
    path.join(cwd, 'node_modules', '@delegance', 'claude-autopilot', 'presets', name, 'autopilot.config.yaml'),
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
  const dest = path.join(cwd, 'autopilot.config.yaml');

  if (fs.existsSync(dest) && !options.force) {
    throw new Error('autopilot.config.yaml already exists — use --force to overwrite');
  }

  console.log('\n[setup] Detecting project type...');

  const detection = detectProject(cwd);
  const label = PRESET_LABELS[detection.preset] ?? detection.preset;

  if (detection.confidence === 'high') {
    console.log(`  ${PASS}  ${label} (${detection.evidence})`);
  } else {
    console.log(`  ${WARN}  ${label} — no strong signals found, defaulted to ${detection.preset}`);
    console.log(`       \x1b[2mEdit autopilot.config.yaml to switch presets if needed\x1b[0m`);
  }
  console.log(`  ${PASS}  Test command: ${detection.testCommand}`);

  const presetConfigPath = findPresetConfig(detection.preset, cwd);
  if (!presetConfigPath) {
    throw new Error(`Preset config not found for: ${detection.preset}. Looked in:\n  ${presetSearchPaths(detection.preset, cwd).join('\n  ')}`);
  }

  let presetContent = await fsAsync.readFile(presetConfigPath, 'utf8');
  presetContent = presetContent.trimEnd() + `\ntestCommand: "${detection.testCommand}"\n`;
  await fsAsync.writeFile(dest, presetContent, 'utf8');
  console.log(`  ${PASS}  Created autopilot.config.yaml`);

  if (!options.skipHook) {
    const hookCode = await runHook('install', { cwd, silent: true });
    if (hookCode === 0) {
      console.log(`  ${PASS}  Installed pre-push git hook`);
    } else {
      console.log(`  ${WARN}  Hook install failed (not fatal — run: npx autopilot hook install)`);
    }
  }

  console.log('\n[setup] Checking prerequisites...');
  await runDoctor();

  console.log('\n[setup] Done. Run: npx autopilot run\n');
}
