// v7.1.7 — Per-calendar-day deprecation dedup.
//
// The previous (v6.3+) implementation keyed the dedup stamp by
// `process.ppid + tty/pipe`, which fails for git-hook invocations because
// git spawns a fresh shell per hook → fresh ppid → fresh stamp file →
// notice prints on every commit. The v7.1.6 blank-repo benchmark agent
// flagged this as the #1 paper cut.
//
// New behavior: stamp at `~/.claude-autopilot/.deprecation-shown`,
// contents = `YYYY-MM-DD` (UTC). Show at most once per day per machine.
// Override env vars (`CLAUDE_AUTOPILOT_DEPRECATION=always|never`)
// preserved.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDRAIL_BIN = path.resolve(__dirname, '..', 'bin', 'guardrail.js');
// Re-route HOME so the test stamp file doesn't collide with the operator's.
let isolatedHome: string;
let originalHome: string | undefined;

before(() => {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-launcher-'));
  originalHome = process.env.HOME;
  // Each spawnSync below uses isolatedHome via the env arg.
});

after(() => {
  if (isolatedHome && fs.existsSync(isolatedHome)) {
    fs.rmSync(isolatedHome, { recursive: true });
  }
  if (originalHome !== undefined) process.env.HOME = originalHome;
});

function runGuardrail(env: Record<string, string | undefined>): { code: number; stderr: string } {
  // Use --version so the launcher does its work then exits cleanly.
  const result = spawnSync(process.execPath, [GUARDRAIL_BIN, '--version'], {
    env: {
      // Inherit minimal PATH so node can find tsx if needed; otherwise
      // wipe so test is hermetic.
      PATH: process.env.PATH,
      // Force a fresh isolated HOME so the stamp file lives in the test dir.
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ...env,
    },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stderr: result.stderr };
}

describe('launcher — deprecation dedup (v7.1.7)', () => {
  it('first guardrail invocation prints the deprecation notice + writes the stamp', () => {
    // Clear any existing stamp from a prior test ordering.
    const stampPath = path.join(isolatedHome, '.claude-autopilot', '.deprecation-shown');
    try { fs.unlinkSync(stampPath); } catch { /* ignore */ }

    const r = runGuardrail({});
    assert.match(r.stderr, /\[deprecated\].*guardrail.*renamed/, 'first invocation prints notice');
    assert.equal(fs.existsSync(stampPath), true, 'stamp file written');
    const stampContent = fs.readFileSync(stampPath, 'utf8').trim();
    assert.match(stampContent, /^\d{4}-\d{2}-\d{2}$/, 'stamp contains YYYY-MM-DD');
  });

  it('second guardrail invocation on the same day SKIPS the notice', () => {
    // Stamp from previous test should still be there.
    const stampPath = path.join(isolatedHome, '.claude-autopilot', '.deprecation-shown');
    assert.equal(fs.existsSync(stampPath), true, 'precondition: stamp exists');
    const r = runGuardrail({});
    assert.equal(r.stderr.includes('[deprecated]'), false, 'notice not re-printed same day');
  });

  it('CLAUDE_AUTOPILOT_DEPRECATION=always re-prints regardless of stamp', () => {
    const r = runGuardrail({ CLAUDE_AUTOPILOT_DEPRECATION: 'always' });
    assert.match(r.stderr, /\[deprecated\]/, 'always override re-prints');
  });

  it('CLAUDE_AUTOPILOT_DEPRECATION=always does NOT update the stamp', () => {
    const stampPath = path.join(isolatedHome, '.claude-autopilot', '.deprecation-shown');
    fs.writeFileSync(stampPath, '1999-01-01');
    runGuardrail({ CLAUDE_AUTOPILOT_DEPRECATION: 'always' });
    const after = fs.readFileSync(stampPath, 'utf8').trim();
    assert.equal(after, '1999-01-01', 'always-mode preserves stamp for testing determinism');
  });

  it('CLAUDE_AUTOPILOT_DEPRECATION=never suppresses regardless of stamp', () => {
    // Remove stamp so default would normally print.
    const stampPath = path.join(isolatedHome, '.claude-autopilot', '.deprecation-shown');
    try { fs.unlinkSync(stampPath); } catch { /* ignore */ }
    const r = runGuardrail({ CLAUDE_AUTOPILOT_DEPRECATION: 'never' });
    assert.equal(r.stderr.includes('[deprecated]'), false, 'never override suppresses');
    assert.equal(fs.existsSync(stampPath), false, 'never override does NOT write stamp');
  });

  it('stale stamp (yesterday) re-prints today', () => {
    const stampPath = path.join(isolatedHome, '.claude-autopilot', '.deprecation-shown');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, yesterday);
    const r = runGuardrail({});
    assert.match(r.stderr, /\[deprecated\]/, 'yesterday-stamped → re-print today');
    const after = fs.readFileSync(stampPath, 'utf8').trim();
    assert.match(after, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(after, yesterday, 'stamp updated to today');
  });
});
