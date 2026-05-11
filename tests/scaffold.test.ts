// v7.2.0 — scaffold --from-spec verb tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSpecFiles,
  buildStarterPackageJson,
  runScaffold,
} from '../src/cli/scaffold.ts';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scaffold-'));
}

function writeSpec(dir: string, body: string): string {
  const p = path.join(dir, 'spec.md');
  fs.writeFileSync(p, body);
  return p;
}

const SAMPLE_SPEC = `# Url Summarizer

Some preamble.

## Files

* \`package.json\` — \`type: module\`, \`bin: { url-summarizer: bin/url-summarizer.js }\`,
  \`dependencies: { @anthropic-ai/sdk: ^0.91 }\`,
  \`scripts: { test: "node --test tests/*.test.js" }\`.
* \`tsconfig.json\` — \`allowJs: true, checkJs: true, noEmit: true\`.
* \`bin/url-summarizer.js\` — argv parser + main loop.
* \`src/summarize.js\` — pure async function.
* \`tests/summarize.test.js\` — node:test cases.
* \`tests/cli.test.js\` — subprocess tests.
* \`README.md\` — usage + install.

## Stabilization

(unrelated section, should be ignored)
`;

describe('parseSpecFiles', () => {
  it('extracts file paths from a `## Files` section', () => {
    const parsed = parseSpecFiles(SAMPLE_SPEC);
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed!.paths.sort(), [
      'README.md',
      'bin/url-summarizer.js',
      'package.json',
      'src/summarize.js',
      'tests/cli.test.js',
      'tests/summarize.test.js',
      'tsconfig.json',
    ]);
  });

  it('returns null when the spec has no `## Files` section', () => {
    const parsed = parseSpecFiles('# Title\n\n## Goals\nNo files heading.\n');
    assert.equal(parsed, null);
  });

  it('extracts package.json hints (type / bin / dependencies / scripts)', () => {
    const parsed = parseSpecFiles(SAMPLE_SPEC);
    assert.equal(parsed!.packageHints.type, 'module');
    assert.deepEqual(parsed!.packageHints.bin, { 'url-summarizer': 'bin/url-summarizer.js' });
    assert.deepEqual(parsed!.packageHints.dependencies, { '@anthropic-ai/sdk': '^0.91' });
    assert.deepEqual(parsed!.packageHints.scripts, { test: 'node --test tests/*.test.js' });
  });

  it('stops at the next ## heading (does not bleed into Stabilization)', () => {
    const parsed = parseSpecFiles(SAMPLE_SPEC);
    // If the parser bled into the Stabilization section it would NOT match
    // any path-shaped backticks (none there), so this is implicitly
    // verified by the path count above. Explicit sanity:
    assert.equal(parsed!.paths.includes('Stabilization'), false);
  });

  it('skips backtick prose that is not path-shaped', () => {
    const md = `## Files\n\n* \`type: module\` is set on package.json\n* \`src/foo.js\` real path\n`;
    const parsed = parseSpecFiles(md);
    // 'type: module' has no path-shape; should be filtered.
    assert.deepEqual(parsed!.paths, ['src/foo.js']);
  });
});

describe('buildStarterPackageJson', () => {
  it('produces a Node 22 ESM starter with sensible defaults', () => {
    const pkg = buildStarterPackageJson('my-pkg', {});
    assert.equal(pkg.name, 'my-pkg');
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.engines, { node: '>=22' });
    const scripts = pkg.scripts as Record<string, string>;
    assert.ok(scripts.test, 'has a default test script');
  });

  it('merges hint-supplied bin / dependencies / scripts', () => {
    const pkg = buildStarterPackageJson('my-pkg', {
      bin: { foo: 'bin/foo.js' },
      dependencies: { ulid: '^3' },
      scripts: { test: 'vitest' },
    });
    assert.deepEqual(pkg.bin, { foo: 'bin/foo.js' });
    assert.deepEqual(pkg.dependencies, { ulid: '^3' });
    const scripts = pkg.scripts as Record<string, string>;
    assert.equal(scripts.test, 'vitest', 'hint overrides default test script');
  });
});

describe('runScaffold (end-to-end)', () => {
  it('scaffolds dirs + placeholder files + package.json + tsconfig from the sample spec', async () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, SAMPLE_SPEC);
    const result = await runScaffold({ cwd: dir, specPath });
    // Directories created.
    assert.ok(fs.existsSync(path.join(dir, 'bin')), 'bin/ exists');
    assert.ok(fs.existsSync(path.join(dir, 'src')), 'src/ exists');
    assert.ok(fs.existsSync(path.join(dir, 'tests')), 'tests/ exists');
    // Placeholder files created (empty).
    for (const p of ['bin/url-summarizer.js', 'src/summarize.js', 'tests/summarize.test.js', 'tests/cli.test.js', 'README.md']) {
      assert.ok(fs.existsSync(path.join(dir, p)), `${p} exists`);
      assert.equal(fs.readFileSync(path.join(dir, p), 'utf8'), '', `${p} is empty placeholder`);
    }
    // package.json created with merged hints.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.bin, { 'url-summarizer': 'bin/url-summarizer.js' });
    assert.deepEqual(pkg.dependencies, { '@anthropic-ai/sdk': '^0.91' });
    assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
    // tsconfig: spec lists .js → JS-flavor (allowJs+checkJs+noEmit).
    const tsc = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
    assert.equal(tsc.compilerOptions.allowJs, true);
    assert.equal(tsc.compilerOptions.checkJs, true);
    assert.equal(tsc.compilerOptions.noEmit, true);
    // Result accounting matches.
    assert.deepEqual(result.dirsCreated.sort(), ['bin', 'src', 'tests']);
    assert.equal(result.packageJsonAction, 'created');
    assert.equal(result.tsconfigAction, 'created');
    fs.rmSync(dir, { recursive: true });
  });

  it('never overwrites existing files (idempotent)', async () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, SAMPLE_SPEC);
    // Pre-populate package.json + one source file.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'preexisting', version: '9.9.9' }));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'summarize.js'), '// existing content');

    const result = await runScaffold({ cwd: dir, specPath });
    // package.json untouched.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'preexisting');
    assert.equal(pkg.version, '9.9.9');
    assert.equal(result.packageJsonAction, 'skipped-exists');
    // Existing source file untouched.
    assert.equal(
      fs.readFileSync(path.join(dir, 'src', 'summarize.js'), 'utf8'),
      '// existing content',
    );
    assert.ok(result.filesSkippedExisting.includes('src/summarize.js'));
    // Other placeholders still created.
    assert.ok(fs.existsSync(path.join(dir, 'bin', 'url-summarizer.js')));
    fs.rmSync(dir, { recursive: true });
  });

  it('--dry-run does not write any files', async () => {
    const dir = makeTmp();
    const specPath = writeSpec(dir, SAMPLE_SPEC);
    const result = await runScaffold({ cwd: dir, specPath, dryRun: true });
    // Reported as if creating, but no files exist.
    assert.ok(result.filesCreated.length > 0, 'reports created files');
    for (const p of result.filesCreated) {
      assert.equal(fs.existsSync(path.join(dir, p)), false, `${p} NOT written in dry-run`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'tsconfig.json')), false);
    fs.rmSync(dir, { recursive: true });
  });

  it('uses TS-flavor tsconfig when spec lists .ts files', async () => {
    const dir = makeTmp();
    const tsSpec = `## Files\n\n* \`tsconfig.json\` — node next\n* \`src/foo.ts\` — pure\n* \`tests/foo.test.ts\` — case\n`;
    const specPath = writeSpec(dir, tsSpec);
    await runScaffold({ cwd: dir, specPath });
    const tsc = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
    assert.equal(tsc.compilerOptions.outDir, 'dist', 'TS flavor sets outDir');
    assert.equal(tsc.compilerOptions.allowJs, undefined, 'TS flavor does not set allowJs');
    fs.rmSync(dir, { recursive: true });
  });
});
