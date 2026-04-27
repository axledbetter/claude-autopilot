import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../src/cli/_pkg-root.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('findPackageRoot', () => {
  it('finds the @delegance/claude-autopilot package root from the source caller', () => {
    const root = findPackageRoot(import.meta.url);
    // The test itself lives at <root>/tests/pkg-root.test.ts
    assert.equal(root, ROOT);
  });

  it('returns null when caller is outside the package tree', () => {
    // /tmp is not inside the package tree
    const root = findPackageRoot('file:///tmp/unrelated/foo.js');
    assert.equal(root, null);
  });

  // Regression: real-world soak found that compiled `dist/src/cli/setup.js`
  // resolved `../../presets/...` to `dist/presets/` (which doesn't exist).
  // After alpha.4, `findPackageRoot` walks up from any caller and lands on the
  // package root regardless of source vs compiled layout.
  it('finds the package root when called from a synthesized compiled-output location', () => {
    // Build the package's own compiled output and verify the helper resolves
    // back up out of dist/.
    const distFile = path.join(ROOT, 'dist', 'src', 'cli', 'index.js');
    if (!fs.existsSync(distFile)) {
      // Skip cleanly if dist hasn't been built — this test is meaningful only
      // when we have compiled output to validate. In CI, `npm run build`
      // happens before `npm test` for some flows; locally `npm run typecheck`
      // does not. Note rather than fail.
      return;
    }
    // Fake a caller URL pointing at the compiled file
    const callerUrl = new URL('file:' + distFile).href;
    const root = findPackageRoot(callerUrl);
    assert.equal(root, ROOT, `compiled caller must walk up out of dist/ to package root; got ${root}`);
  });
});

describe('init --preset generic resolves preset config from compiled layout', () => {
  it('writes guardrail.config.yaml when invoked from a fresh project against the compiled bundle', () => {
    const distEntry = path.join(ROOT, 'dist', 'src', 'cli', 'index.js');
    if (!fs.existsSync(distEntry)) {
      // Build hasn't happened — skip this regression test (the unit test above
      // covers the helper function directly). Note rather than fail.
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-init-smoke-'));
    try {
      // Seed a minimal package.json so detector falls back to `generic`
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'init-smoke-fixture',
        version: '0.0.0',
        scripts: { test: 'echo' },
      }));

      const r = spawnSync(process.execPath, [distEntry, 'init', '--preset', 'generic'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 15_000,
        // init may read stdin for prompt; closing it keeps the test deterministic
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      assert.equal(r.status, 0, `init exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(
        fs.existsSync(path.join(tmp, 'guardrail.config.yaml')),
        `init must write guardrail.config.yaml; cwd contents: ${fs.readdirSync(tmp).join(', ')}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
