#!/usr/bin/env node
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  'nextjs-supabase': 'Next.js App Router + Supabase (Postgres + RLS)',
  't3': 'T3 Stack (Next.js + tRPC + Prisma + NextAuth)',
  'rails-postgres': 'Ruby on Rails 7 + PostgreSQL',
  'python-fastapi': 'Python FastAPI + SQLAlchemy + Alembic',
  'go': 'Go + PostgreSQL (pgx/v5)',
};

const PRESET_NAMES = Object.keys(PRESET_DESCRIPTIONS);

export async function runInit(cwd: string = process.cwd()): Promise<void> {
  const dest = path.join(cwd, 'autopilot.config.yaml');

  if (fs.existsSync(dest)) {
    console.error(`\x1b[33m[init] autopilot.config.yaml already exists — remove it first to re-init\x1b[0m`);
    process.exit(1);
  }

  console.log('\n\x1b[1m[autopilot init] Choose a preset:\x1b[0m\n');
  PRESET_NAMES.forEach((name, i) => {
    console.log(`  ${i + 1}. ${name.padEnd(22)} ${PRESET_DESCRIPTIONS[name]}`);
  });
  console.log('');

  const rl = readline.createInterface({ input, output });
  let choice: number;
  try {
    const answer = await rl.question('  Enter number (or preset name): ');
    rl.close();
    const trimmed = answer.trim();
    const byName = PRESET_NAMES.indexOf(trimmed);
    if (byName >= 0) {
      choice = byName;
    } else {
      const n = parseInt(trimmed, 10);
      if (isNaN(n) || n < 1 || n > PRESET_NAMES.length) {
        console.error(`\x1b[31m[init] Invalid selection: "${trimmed}"\x1b[0m`);
        process.exit(1);
      }
      choice = n - 1;
    }
  } catch {
    rl.close();
    process.exit(0);
  }

  const presetName = PRESET_NAMES[choice]!;
  const presetConfigPath = findPresetConfig(presetName);
  if (!presetConfigPath) {
    console.error(`\x1b[31m[init] Preset config not found for: ${presetName}\x1b[0m`);
    console.error(`       Looked in: ${presetSearchPaths(presetName).join(', ')}`);
    process.exit(1);
  }

  const presetContent = await fsAsync.readFile(presetConfigPath, 'utf8');
  await fsAsync.writeFile(dest, presetContent, 'utf8');

  console.log(`\n\x1b[32m✓\x1b[0m  Created autopilot.config.yaml from preset \x1b[1m${presetName}\x1b[0m`);
  console.log('\nNext steps:');
  console.log('  1. Review autopilot.config.yaml and adjust testCommand / protectedPaths');
  console.log('  2. Set OPENAI_API_KEY in your environment (for Codex review)');
  console.log('  3. Run your first pipeline to verify the setup:');
  console.log('       npx autopilot run');
  console.log('  4. Generate snapshot baselines after your first feature lands:');
  console.log('       npx autopilot autoregress generate');
  console.log('  5. Install the pre-push git hook (enforces snapshots on push):');
  console.log('       npx autopilot hook install');
  console.log('  6. (Optional) Add CI with GitHub Actions:');
  console.log('       uses: axledbetter/claude-autopilot/.github/actions/ci@main\n');
}

function presetSearchPaths(name: string): string[] {
  // fileURLToPath handles encoded chars and Windows drive letters safely
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return [
    path.join(pkgRoot, 'presets', name, 'autopilot.config.yaml'),
    path.join(process.cwd(), 'presets', name, 'autopilot.config.yaml'),
    path.join(process.cwd(), 'node_modules', '@delegance', 'claude-autopilot', 'presets', name, 'autopilot.config.yaml'),
  ];
}

function findPresetConfig(name: string): string | null {
  for (const p of presetSearchPaths(name)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
