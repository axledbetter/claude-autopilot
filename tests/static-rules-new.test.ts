import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rules-')); }

// ── hardcoded-secrets ────────────────────────────────────────────────────────
describe('hardcoded-secrets', () => {
  it('flags hardcoded password assignment', async () => {
    const { hardcodedSecretsRule } = await import('../src/core/static-rules/rules/hardcoded-secrets.ts');
    const dir = tmp();
    const file = path.join(dir, 'config.ts');
    fs.writeFileSync(file, 'const password = "supersecret123";\n');
    const findings = await hardcodedSecretsRule.check([file]);
    assert.ok(findings.length > 0, 'expected finding');
    assert.equal(findings[0]!.category, 'hardcoded-secrets');
    fs.rmSync(dir, { recursive: true });
  });

  it('ignores placeholder values', async () => {
    const { hardcodedSecretsRule } = await import('../src/core/static-rules/rules/hardcoded-secrets.ts');
    const dir = tmp();
    const file = path.join(dir, 'config.ts');
    fs.writeFileSync(file, 'const password = "YOUR_PASSWORD_HERE";\n');
    const findings = await hardcodedSecretsRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips test files', async () => {
    const { hardcodedSecretsRule } = await import('../src/core/static-rules/rules/hardcoded-secrets.ts');
    const dir = tmp();
    const file = path.join(dir, 'auth.test.ts');
    fs.writeFileSync(file, 'const password = "supersecret123";\n');
    const findings = await hardcodedSecretsRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── console-log ───────────────────────────────────────────────────────────────
describe('console-log', () => {
  it('flags console.log in production ts file', async () => {
    const { consoleLogRule } = await import('../src/core/static-rules/rules/console-log.ts');
    const dir = tmp();
    const file = path.join(dir, 'service.ts');
    fs.writeFileSync(file, 'export function foo() {\n  console.log("debug");\n}\n');
    const findings = await consoleLogRule.check([file]);
    assert.ok(findings.length > 0);
    assert.equal(findings[0]!.line, 2);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips console.log in test files', async () => {
    const { consoleLogRule } = await import('../src/core/static-rules/rules/console-log.ts');
    const dir = tmp();
    const file = path.join(dir, 'service.test.ts');
    fs.writeFileSync(file, 'console.log("ok");\n');
    const findings = await consoleLogRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips commented-out console.log', async () => {
    const { consoleLogRule } = await import('../src/core/static-rules/rules/console-log.ts');
    const dir = tmp();
    const file = path.join(dir, 'service.ts');
    fs.writeFileSync(file, '// console.log("debug");\n');
    const findings = await consoleLogRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── todo-fixme ────────────────────────────────────────────────────────────────
describe('todo-fixme', () => {
  it('flags TODO comment', async () => {
    const { todoFixmeRule } = await import('../src/core/static-rules/rules/todo-fixme.ts');
    const dir = tmp();
    const file = path.join(dir, 'index.ts');
    fs.writeFileSync(file, '// TODO: fix this later\nexport const x = 1;\n');
    const findings = await todoFixmeRule.check([file]);
    assert.ok(findings.length > 0);
    assert.equal(findings[0]!.line, 1);
    fs.rmSync(dir, { recursive: true });
  });

  it('flags FIXME comment', async () => {
    const { todoFixmeRule } = await import('../src/core/static-rules/rules/todo-fixme.ts');
    const dir = tmp();
    const file = path.join(dir, 'index.ts');
    fs.writeFileSync(file, 'export const x = 1; // FIXME: broken\n');
    const findings = await todoFixmeRule.check([file]);
    assert.equal(findings.length, 1);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns no findings for clean file', async () => {
    const { todoFixmeRule } = await import('../src/core/static-rules/rules/todo-fixme.ts');
    const dir = tmp();
    const file = path.join(dir, 'index.ts');
    fs.writeFileSync(file, 'export const x = 1;\n');
    const findings = await todoFixmeRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── large-file ────────────────────────────────────────────────────────────────
describe('large-file', () => {
  it('flags file over threshold', async () => {
    const { largeFileRule } = await import('../src/core/static-rules/rules/large-file.ts');
    const dir = tmp();
    const file = path.join(dir, 'big.ts');
    fs.writeFileSync(file, Array(600).fill('const x = 1;').join('\n'));
    const findings = await largeFileRule.check([file]);
    assert.ok(findings.length > 0);
    assert.ok(findings[0]!.message.includes('600'));
    fs.rmSync(dir, { recursive: true });
  });

  it('passes file under threshold', async () => {
    const { largeFileRule } = await import('../src/core/static-rules/rules/large-file.ts');
    const dir = tmp();
    const file = path.join(dir, 'small.ts');
    fs.writeFileSync(file, Array(50).fill('const x = 1;').join('\n'));
    const findings = await largeFileRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── package-lock-sync ─────────────────────────────────────────────────────────
describe('package-lock-sync', () => {
  it('flags package.json change without lockfile change', async () => {
    const { packageLockSyncRule } = await import('../src/core/static-rules/rules/package-lock-sync.ts');
    const cwd = process.cwd();
    // Simulate: package.json touched, package-lock.json exists but not touched
    const findings = await packageLockSyncRule.check(['package.json']);
    // Only flags if package-lock.json exists in cwd
    if (fs.existsSync(path.join(cwd, 'package-lock.json'))) {
      assert.ok(findings.length > 0);
      assert.equal(findings[0]!.category, 'package-lock-sync');
    }
  });

  it('returns no findings when neither file touched', async () => {
    const { packageLockSyncRule } = await import('../src/core/static-rules/rules/package-lock-sync.ts');
    const findings = await packageLockSyncRule.check(['src/index.ts']);
    assert.equal(findings.length, 0);
  });
});

// ── missing-tests ───────────────────────────────────────────────────────────
describe('missing-tests', () => {
  it('flags source file with no test counterpart', async () => {
    const { missingTestsRule } = await import('../src/core/static-rules/rules/missing-tests.ts');
    const findings = await missingTestsRule.check(['src/unique-xyz-no-test.ts']);
    assert.ok(findings.length > 0);
    assert.equal(findings[0]!.category, 'missing-tests');
  });

  it('passes when test file is in touched list', async () => {
    const { missingTestsRule } = await import('../src/core/static-rules/rules/missing-tests.ts');
    const findings = await missingTestsRule.check(['src/unique-xyz-no-test.ts', 'src/unique-xyz-no-test.test.ts']);
    assert.equal(findings.length, 0);
  });
});

// ── registry ──────────────────────────────────────────────────────────────────
describe('rule registry', () => {
  it('loads all built-in rules by name', async () => {
    const { loadRulesFromConfig, listAvailableRules } = await import('../src/core/static-rules/registry.ts');
    const names = listAvailableRules();
    const expected = ['hardcoded-secrets', 'npm-audit', 'package-lock-sync', 'console-log', 'todo-fixme', 'large-file', 'missing-tests'];
    for (const name of expected) {
      assert.ok(names.includes(name), `missing: ${name}`);
    }
  });

  it('loads multiple rules from config refs', async () => {
    const { loadRulesFromConfig } = await import('../src/core/static-rules/registry.ts');
    const rules = await loadRulesFromConfig(['console-log', 'todo-fixme']);
    assert.equal(rules.length, 2);
    assert.equal(rules[0]!.name, 'console-log');
    assert.equal(rules[1]!.name, 'todo-fixme');
  });

  it('skips unknown rule names with a warning', async () => {
    const { loadRulesFromConfig } = await import('../src/core/static-rules/registry.ts');
    const rules = await loadRulesFromConfig(['console-log', 'nonexistent-rule']);
    assert.equal(rules.length, 1);
  });
});
