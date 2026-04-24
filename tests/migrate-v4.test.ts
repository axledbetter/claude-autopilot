import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Spawn codemod via dynamic import to avoid re-importing preflight which has
// side effects. The migrate-v4 module is pure.
async function loadMigrateV4() {
  const mod = await import('../src/cli/migrate-v4.ts');
  return mod.runMigrateV4;
}

function seedFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-migrate-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'test-consumer',
    version: '1.0.0',
    dependencies: {
      '@delegance/guardrail': '^4.3.1',
      'lodash': '^4',
    },
    devDependencies: {
      '@delegance/guardrail': '^4.3.1',
    },
    scripts: {
      'review': 'guardrail run --base main',
    },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'Dockerfile'),
    `FROM node:22-alpine
RUN npm install -g @delegance/guardrail@^4
CMD ["guardrail", "ci"]
`);
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'review.yml'),
    `name: Review
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - run: npm install -g @delegance/guardrail
      - run: guardrail run --base main --format sarif --output out.sarif
`);
  fs.writeFileSync(path.join(dir, 'scripts', 'pre-push.sh'),
    `#!/bin/sh
guardrail run --base main --fail-on critical
`, { flag: 'w' });
  return dir;
}

function mkScriptsDir(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
}

describe('migrate-v4 codemod', () => {
  it('dry-run reports replacements across all file types without mutating', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-dry-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@delegance/guardrail': '^4.3.1' },
    }));
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    await runMigrateV4({ cwd: dir, write: false });
    const after = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.equal(before, after, 'dry-run must not mutate files');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--write replaces @delegance/guardrail across package.json sections preserving operator', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-pkg-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@delegance/guardrail': '^4.3.1', 'keep-me': '^1' },
      devDependencies: { '@delegance/guardrail': '~4.2.0' },
      peerDependencies: { '@delegance/guardrail': '>=4.0.0' },
    }, null, 2));

    await runMigrateV4({ cwd: dir, write: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

    assert.equal(pkg.dependencies['@delegance/guardrail'], undefined, 'old key must be removed');
    assert.ok(pkg.dependencies['@delegance/claude-autopilot'].startsWith('^'), 'preserve ^ operator');
    assert.ok(pkg.dependencies['@delegance/claude-autopilot'].includes('5.0.0'), 'bump to 5.0.0-alpha');
    assert.equal(pkg.devDependencies['@delegance/claude-autopilot'][0], '~', 'preserve ~ operator');
    assert.equal(pkg.peerDependencies['@delegance/claude-autopilot'].slice(0, 2), '>=', 'preserve >= operator');
    assert.equal(pkg.dependencies['keep-me'], '^1', 'untouched deps stay');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--write replaces guardrail CLI invocations in shell scripts and workflows', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = seedFixture();
    mkScriptsDir(dir);
    await runMigrateV4({ cwd: dir, write: true });

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.review, /claude-autopilot run --base main/);

    const docker = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
    assert.match(docker, /@delegance\/claude-autopilot/);
    assert.match(docker, /\["claude-autopilot", "ci"\]/);

    const wf = fs.readFileSync(path.join(dir, '.github', 'workflows', 'review.yml'), 'utf8');
    assert.match(wf, /claude-autopilot run --base main/);
    assert.match(wf, /@delegance\/claude-autopilot/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--write emits a manifest with sha256 hashes and backup files', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-manifest-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@delegance/guardrail': '^4.3.1' },
    }));

    await runMigrateV4({ cwd: dir, write: true });
    const manifestPath = path.join(dir, '.claude-autopilot', 'migrate-v4-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest written');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.entries.length, 1);
    const entry = manifest.entries[0];
    assert.ok(entry.beforeSha256.length === 64, 'sha256 before hash');
    assert.ok(entry.afterSha256.length === 64, 'sha256 after hash');
    assert.ok(fs.existsSync(entry.backupPath), 'backup file created');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--undo restores files from backup when hashes match', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-undo-'));
    const original = JSON.stringify({
      dependencies: { '@delegance/guardrail': '^4.3.1' },
    }, null, 2) + '\n';
    fs.writeFileSync(path.join(dir, 'package.json'), original);

    await runMigrateV4({ cwd: dir, write: true });
    const migrated = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.notEqual(migrated, original);

    await runMigrateV4({ cwd: dir, undo: true });
    const restored = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.equal(restored, original, 'file restored to original content');
    assert.ok(!fs.existsSync(path.join(dir, '.claude-autopilot', 'migrate-v4-manifest.json')), 'manifest removed');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--undo refuses to overwrite files modified after migrate', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-tamper-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@delegance/guardrail': '^4.3.1' },
    }));

    await runMigrateV4({ cwd: dir, write: true });
    // User edits the file after migrate — undo must refuse to overwrite
    fs.writeFileSync(path.join(dir, 'package.json'), '{"modified": "by user"}');

    const code = await runMigrateV4({ cwd: dir, undo: true });
    assert.equal(code, 1, 'undo must exit non-zero when any file refused');

    const still = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.equal(still, '{"modified": "by user"}', 'user edit preserved');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites npx / pnpm dlx / yarn dlx / bunx wrappers', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-wrap-'));
    fs.writeFileSync(path.join(dir, 'ci.sh'), [
      '#!/bin/sh',
      'npx guardrail run --base main',
      'pnpm dlx guardrail ci',
      'yarn dlx guardrail scan src/',
      'bunx guardrail fix --dry-run',
      '',
    ].join('\n'));

    await runMigrateV4({ cwd: dir, write: true });
    const updated = fs.readFileSync(path.join(dir, 'ci.sh'), 'utf8');

    // All four wrappers rewritten to use the new package name AND their original
    // subcommand preserved.
    assert.match(updated, /npx @delegance\/claude-autopilot@alpha run --base main/);
    assert.match(updated, /pnpm dlx @delegance\/claude-autopilot@alpha ci/);
    assert.match(updated, /yarn dlx @delegance\/claude-autopilot@alpha scan src\//);
    assert.match(updated, /bunx @delegance\/claude-autopilot@alpha fix --dry-run/);
    // No stray legacy reference
    assert.doesNotMatch(updated, /\bguardrail (run|ci|scan|fix)\b/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not touch node_modules or dist', async () => {
    const runMigrateV4 = await loadMigrateV4();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-m4-skip-'));
    // Seed content under node_modules and dist that matches the patterns
    fs.mkdirSync(path.join(dir, 'node_modules', 'victim'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'victim', 'package.json'),
      JSON.stringify({ dependencies: { '@delegance/guardrail': '^4' } }));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'out.sh'), 'guardrail run\n');

    await runMigrateV4({ cwd: dir, write: true });

    const victimPkg = fs.readFileSync(path.join(dir, 'node_modules', 'victim', 'package.json'), 'utf8');
    assert.match(victimPkg, /@delegance\/guardrail/, 'node_modules must not be touched');
    const distSh = fs.readFileSync(path.join(dir, 'dist', 'out.sh'), 'utf8');
    assert.match(distSh, /guardrail run/, 'dist must not be touched');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
