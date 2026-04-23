import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toJUnit } from '../src/formatters/junit.ts';
import type { RunResult } from '../src/core/pipeline/run.ts';

function makeResult(findings: Array<Partial<{ id: string; severity: string; category: string; file: string; line: number; message: string }>> = []): RunResult {
  return {
    status: findings.some(f => f.severity === 'critical') ? 'fail' : findings.length > 0 ? 'warn' : 'pass',
    phases: [],
    allFindings: findings.map((f, i) => ({
      id: f.id ?? `r${i}`,
      source: 'static-rules' as const,
      severity: (f.severity ?? 'critical') as 'critical' | 'warning' | 'note',
      category: f.category ?? 'test',
      file: f.file ?? 'src/index.ts',
      line: f.line ?? i + 1,
      message: f.message ?? 'test finding',
      suggestion: 'fix it',
      protectedPath: false,
      createdAt: new Date().toISOString(),
    })),
    durationMs: 1234,
  };
}

describe('JUnit formatter', () => {
  it('produces valid XML declaration', () => {
    const xml = toJUnit(makeResult());
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  });

  it('empty findings — emits passing testcase', () => {
    const xml = toJUnit(makeResult());
    assert.ok(xml.includes('<testcase name="no findings"'));
    assert.ok(xml.includes('failures="0"'));
  });

  it('critical finding becomes failure element', () => {
    const xml = toJUnit(makeResult([{ severity: 'critical', message: 'SQL injection risk', category: 'sql-injection' }]));
    assert.ok(xml.includes('<failure'));
    assert.ok(xml.includes('sql-injection'));
    assert.ok(xml.includes('SQL injection risk'));
    assert.ok(xml.includes('failures="1"'));
  });

  it('warning finding becomes system-out element (not failure)', () => {
    const xml = toJUnit(makeResult([{ severity: 'warning', message: 'open redirect' }]));
    assert.ok(xml.includes('<system-out>'));
    assert.ok(!xml.includes('<failure'));
    assert.ok(xml.includes('failures="0"'));
  });

  it('escapes XML special characters', () => {
    const xml = toJUnit(makeResult([{ message: 'SQL <injection> & "xss" attack', severity: 'critical' }]));
    assert.ok(!xml.includes('<injection>'), 'angle brackets should be escaped');
    assert.ok(xml.includes('&lt;injection&gt;'));
    assert.ok(xml.includes('&amp;'));
  });

  it('sets test count to total findings', () => {
    const xml = toJUnit(makeResult([
      { severity: 'critical' },
      { severity: 'warning' },
      { severity: 'note' },
    ]));
    assert.ok(xml.includes('tests="3"'));
    assert.ok(xml.includes('failures="1"'));
  });

  it('includes file:line in test case name', () => {
    const xml = toJUnit(makeResult([{ file: 'src/db.ts', line: 42, category: 'sql-injection' }]));
    assert.ok(xml.includes('src/db.ts:42'));
  });

  it('custom suite name', () => {
    const xml = toJUnit(makeResult(), { suiteName: 'my-project' });
    assert.ok(xml.includes('name="my-project"'));
  });

  it('duration in seconds with 3 decimal places', () => {
    const xml = toJUnit(makeResult());
    assert.ok(xml.includes('time="1.234"'));
  });
});
