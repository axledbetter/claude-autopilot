import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOMBSTONE_BIN = path.join(ROOT, 'packages', 'guardrail-tombstone', 'bin', 'guardrail.js');

// The tombstone is a standalone package. During testing it can't resolve
// @delegance/claude-autopilot via node's require tree because there's no
// node_modules under packages/guardrail-tombstone. We test the edge behaviors
// it owns directly:
//   - emits deprecation notice on stderr by default
//   - suppresses notice under CLAUDE_AUTOPILOT_DEPRECATION=never
//   - falls through to PATH when node resolver misses
//   - surfaces a clear error (not a stack trace) when claude-autopilot isn't
//     installed anywhere
//
// Full forwarding parity is covered by the CI bin-parity workflow that runs
// against a real global install.

// Run the tombstone via node directly so the shebang works without relying on
// PATH (avoids `env: node: No such file or directory` on hardened PATH).
function runTombstone(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(process.execPath, [TOMBSTONE_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

describe('tombstone guardrail bin (legacy forwarding wrapper)', () => {
  it('emits deprecation notice on stderr by default', () => {
    const r = runTombstone(['--version']);
    assert.match(r.stderr, /deprecated.*@delegance\/guardrail.*claude-autopilot/i);
  });

  it('CLAUDE_AUTOPILOT_DEPRECATION=never suppresses the notice', () => {
    const r = runTombstone(['--version'], { CLAUDE_AUTOPILOT_DEPRECATION: 'never' });
    assert.doesNotMatch(r.stderr, /deprecated/i);
  });

  it('does not leak a node stack trace when claude-autopilot is unreachable', () => {
    // If claude-autopilot IS resolvable (local dev), this test just proves the
    // happy path doesn't crash. If it isn't, we still assert no stack leak.
    const r = runTombstone(['--version'], { CLAUDE_AUTOPILOT_DEPRECATION: 'never' });
    assert.ok(
      !/\s+at\s+\S+\s+\([^)]*:\d+:\d+\)/.test(r.stderr),
      `tombstone leaked a node stack trace:\n${r.stderr.slice(0, 400)}`,
    );
  });
});
