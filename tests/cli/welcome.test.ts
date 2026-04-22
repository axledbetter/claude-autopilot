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

  it('WS2: shows @delegance/guardrail branding', () => {
    const r = runCli([]);
    assert.ok(r.stdout.includes('@delegance/guardrail'), `stdout: ${r.stdout}`);
  });

  it('WS3: shows Quick start section with run command', () => {
    const r = runCli([]);
    assert.ok(r.stdout.includes('guardrail run'), `stdout: ${r.stdout}`);
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
});
