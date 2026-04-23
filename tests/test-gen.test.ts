import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCoverageGaps } from '../src/core/test-gen/coverage-analyzer.ts';
import { detectTestFramework } from '../src/core/test-gen/framework-detector.ts';
import { buildGenerationPrompt, writeGeneratedTest } from '../src/core/test-gen/test-writer.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')); }
function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('findCoverageGaps', () => {
  it('returns empty when no exports', () => {
    const dir = tmp();
    const f = write(dir, 'src/a.ts', 'const x = 1;');
    assert.deepEqual(findCoverageGaps([f]), []);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns gap when exported function has no test file', () => {
    const dir = tmp();
    const f = write(dir, 'src/a.ts', 'export function foo() {}');
    const gaps = findCoverageGaps([f]);
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0]!.exports.includes('foo'));
    fs.rmSync(dir, { recursive: true });
  });

  it('skips test files themselves', () => {
    const dir = tmp();
    const f = write(dir, 'src/a.test.ts', 'export function foo() {}');
    assert.deepEqual(findCoverageGaps([f]), []);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns no gap when test file references the export', () => {
    const dir = tmp();
    write(dir, 'src/a.ts', 'export function foo() {}');
    const f = path.join(dir, 'src/a.ts');
    write(dir, 'src/a.test.ts', "import { foo } from './a'; describe('foo', () => {})");
    const gaps = findCoverageGaps([f]);
    assert.equal(gaps.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('detects multiple uncovered exports', () => {
    const dir = tmp();
    const f = write(dir, 'src/b.ts', [
      'export function alpha() {}',
      'export const beta = 1;',
      'export class Gamma {}',
    ].join('\n'));
    const gaps = findCoverageGaps([f]);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.exports.length, 3);
    fs.rmSync(dir, { recursive: true });
  });

  it('reports only uncovered exports when test file partially covers', () => {
    const dir = tmp();
    write(dir, 'src/c.ts', 'export function alpha() {}\nexport function beta() {}');
    const f = path.join(dir, 'src/c.ts');
    write(dir, 'src/c.test.ts', "import { alpha } from './c'; it('alpha', () => alpha())");
    const gaps = findCoverageGaps([f]);
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0]!.exports.includes('beta'));
    assert.ok(!gaps[0]!.exports.includes('alpha'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detectTestFramework', () => {
  it('returns node:test when no package.json', () => {
    const dir = tmp();
    assert.equal(detectTestFramework(dir), 'node:test');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects jest from devDependencies', () => {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ devDependencies: { jest: '^29' } }));
    assert.equal(detectTestFramework(dir), 'jest');
    fs.rmSync(dir, { recursive: true });
  });

  it('detects vitest from devDependencies', () => {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ devDependencies: { vitest: '^1' } }));
    assert.equal(detectTestFramework(dir), 'vitest');
    fs.rmSync(dir, { recursive: true });
  });

  it('prefers vitest over jest when both present', () => {
    const dir = tmp();
    write(dir, 'package.json', JSON.stringify({ devDependencies: { vitest: '^1', jest: '^29' } }));
    assert.equal(detectTestFramework(dir), 'vitest');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('buildGenerationPrompt', () => {
  it('includes export names and framework in prompt', () => {
    const dir = tmp();
    const gap = { file: path.join(dir, 'src/a.ts'), exports: ['foo', 'bar'], testFile: path.join(dir, 'src/a.test.ts') };
    const prompt = buildGenerationPrompt(gap, 'export function foo() {}', 'jest');
    assert.ok(prompt.includes('foo'));
    assert.ok(prompt.includes('bar'));
    assert.ok(prompt.includes('jest'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('writeGeneratedTest', () => {
  it('writes content to testFile path, creating dirs', () => {
    const dir = tmp();
    const gap = {
      file: path.join(dir, 'src/a.ts'),
      exports: ['foo'],
      testFile: path.join(dir, 'src/__tests__/a.test.ts'),
    };
    const written = writeGeneratedTest(gap, "import { foo } from '../a';\nit('works', () => {});");
    assert.ok(fs.existsSync(written));
    assert.ok(fs.readFileSync(written, 'utf8').includes('foo'));
    fs.rmSync(dir, { recursive: true });
  });
});
