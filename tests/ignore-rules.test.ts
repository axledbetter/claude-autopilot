import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadIgnoreRules, applyIgnoreRules } from '../src/core/ignore/index.ts';
import type { Finding } from '../src/core/findings/types.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'hardcoded-secrets',
    source: 'static-rules',
    severity: 'critical',
    category: 'security',
    file: 'src/config.ts',
    message: 'hardcoded secret',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ignore-')); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeIgnore(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.guardrail-ignore'), content, 'utf8');
}

describe('loadIgnoreRules', () => {
  it('returns empty array when no file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-no-ignore-'));
    assert.deepEqual(loadIgnoreRules(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses rule-id + glob', () => {
    writeIgnore('hardcoded-secrets src/legacy/**\n');
    const rules = loadIgnoreRules(tmpDir);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.ruleId, 'hardcoded-secrets');
    assert.equal(rules[0]!.pathGlob, 'src/legacy/**');
  });

  it('parses bare glob as wildcard rule', () => {
    writeIgnore('tests/**\n');
    const rules = loadIgnoreRules(tmpDir);
    assert.equal(rules[0]!.ruleId, '*');
    assert.equal(rules[0]!.pathGlob, 'tests/**');
  });

  it('skips comments and blank lines', () => {
    writeIgnore('# this is a comment\n\nhardcoded-secrets src/vendor/**\n');
    const rules = loadIgnoreRules(tmpDir);
    assert.equal(rules.length, 1);
  });
});

describe('applyIgnoreRules', () => {
  it('returns all findings when no rules', () => {
    const findings = [makeFinding(), makeFinding({ id: 'console-log' })];
    assert.equal(applyIgnoreRules(findings, []).length, 2);
  });

  it('suppresses finding matching rule-id + path glob', () => {
    writeIgnore('hardcoded-secrets src/**\n');
    const rules = loadIgnoreRules(tmpDir);
    const findings = [makeFinding({ file: 'src/config.ts' }), makeFinding({ id: 'console-log', file: 'src/app.ts' })];
    const result = applyIgnoreRules(findings, rules);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'console-log');
  });

  it('wildcard rule suppresses any finding on matching path', () => {
    writeIgnore('* tests/**\n');
    const rules = loadIgnoreRules(tmpDir);
    const findings = [
      makeFinding({ file: 'tests/foo.test.ts' }),
      makeFinding({ file: 'src/app.ts' }),
    ];
    const result = applyIgnoreRules(findings, rules);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.file, 'src/app.ts');
  });

  it('bare glob (matchBase) suppresses by filename', () => {
    writeIgnore('*.test.ts\n');
    const rules = loadIgnoreRules(tmpDir);
    const findings = [
      makeFinding({ file: 'tests/auth.test.ts' }),
      makeFinding({ file: 'src/app.ts' }),
    ];
    const result = applyIgnoreRules(findings, rules);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.file, 'src/app.ts');
  });
});
