import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[], env?: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', ENTRY, ...args],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

describe('welcome screen (bare invocation)', () => {
  it('WS1: exits 0 with no args', () => {
    const r = runCli([]);
    assert.equal(r.code, 0);
  });

  it('WS2: shows @delegance/claude-autopilot branding', () => {
    const r = runCli([]);
    assert.ok(r.stdout.includes('@delegance/claude-autopilot'), `stdout: ${r.stdout}`);
  });

  it('WS3: shows Quick start section with pipeline + review entrypoints', () => {
    const r = runCli([]);
    // Pipeline brainstorm is the new top-billing quickstart. Review commands
    // (`claude-autopilot run`) remain shown as the v4-compatible alternative.
    assert.ok(
      r.stdout.includes('brainstorm'),
      `stdout is missing pipeline brainstorm quickstart: ${r.stdout}`,
    );
    assert.ok(
      r.stdout.includes('claude-autopilot run'),
      `stdout is missing review-phase run command: ${r.stdout}`,
    );
  });

  it('WS4: shows no-key warning when API keys absent', () => {
    const r = runCli([], {
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      GROQ_API_KEY: '',
    });
    assert.ok(
      r.stdout.includes('No LLM API key') || r.stdout.includes('ANTHROPIC_API_KEY'),
      `stdout: ${r.stdout}`,
    );
  });

  it('WS5: shows key-detected message when ANTHROPIC_API_KEY is set', () => {
    const r = runCli([], { ANTHROPIC_API_KEY: 'test-key' });
    assert.ok(r.stdout.includes('detected'), `stdout: ${r.stdout}`);
  });

  it('WS6: every command shown in the welcome quickstart actually routes', () => {
    // Regression guard — welcome screen must not advertise nonexistent subcommands.
    // Alpha.3 surfaced this when `brainstorm` was promoted to the top-billing
    // quickstart but wasn't in SUBCOMMANDS, so users would hit "Unknown subcommand".
    assertAllSuggestedSubcommandsRoute(runCli([]).stdout, 'welcome screen');
  });

  it('WS7: every command shown in the `brainstorm` handler output actually routes', () => {
    // Same regression guard applied to the brainstorm help output. The fix for
    // WS6 accidentally introduced `claude-autopilot migrate` in this text —
    // `migrate` is a Claude Code skill, not a CLI subcommand. This test locks
    // the door against that class of recursive bug.
    assertAllSuggestedSubcommandsRoute(runCli(['brainstorm']).stdout, 'brainstorm handler');
  });
});

function assertAllSuggestedSubcommandsRoute(output: string, source: string): void {
  const suggested = new Set<string>();
  for (const m of output.matchAll(/claude-autopilot\s+([\w-]+)/g)) {
    const sub = m[1]!;
    if (!sub.startsWith('-')) suggested.add(sub);
  }

  assert.ok(suggested.size > 0, `${source} must advertise at least one subcommand`);

  for (const sub of suggested) {
    const r = runCli([sub, '--help']);
    const combined = r.stdout + r.stderr;
    assert.ok(
      !new RegExp(`Unknown subcommand: "${sub}"`, 'i').test(combined),
      `${source} advertises \`claude-autopilot ${sub}\` but dispatcher rejects it. ` +
      `Either add a handler or stop advertising it.\nOutput:\n${combined.slice(0, 300)}`,
    );
  }
}
