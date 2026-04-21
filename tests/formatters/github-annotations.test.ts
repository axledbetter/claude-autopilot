import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitAnnotations,
  encodeAnnotationProperty,
  encodeAnnotationData,
} from '../../src/formatters/github-annotations.ts';
import type { Finding } from '../../src/core/findings/types.ts';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'static-rules',
    severity: 'warning',
    category: 'test-rule',
    file: 'src/foo.ts',
    line: 10,
    message: 'test message',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown) => { chunks.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return chunks.join('');
}

describe('emitAnnotations', () => {
  beforeEach(() => { process.env.GITHUB_ACTIONS = 'true'; });
  afterEach(() => { delete process.env.GITHUB_ACTIONS; });

  it('A1: critical → ::error command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'critical' })]));
    assert.ok(out.startsWith('::error '), `expected ::error, got: ${out}`);
  });

  it('A2: warning → ::warning command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'warning' })]));
    assert.ok(out.startsWith('::warning '), `expected ::warning, got: ${out}`);
  });

  it('A3: note → ::notice command', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ severity: 'note' })]));
    assert.ok(out.startsWith('::notice '), `expected ::notice, got: ${out}`);
  });

  it('A4: finding with line → file=...,line=N,endLine=N in props', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ file: 'src/x.ts', line: 7 })]));
    assert.ok(out.includes('file=src/x.ts'), `missing file=: ${out}`);
    assert.ok(out.includes('line=7'), `missing line=7: ${out}`);
    assert.ok(out.includes('endLine=7'), `missing endLine=7: ${out}`);
  });

  it('A5: finding without line → no line= property', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ line: undefined })]));
    assert.ok(!out.includes('line='), `unexpected line= in: ${out}`);
  });

  it('A6: empty findings → no output', () => {
    const out = captureStdout(() => emitAnnotations([]));
    assert.equal(out, '');
  });

  it('A7: message with %, newline → percent-encoded in data', () => {
    const out = captureStdout(() => emitAnnotations([makeFinding({ message: '100% done\nfix it' })]));
    const dataStart = out.lastIndexOf('::') + 2;
    const data = out.slice(dataStart);
    assert.ok(data.includes('%25'), `% not encoded: ${data}`);
    assert.ok(data.includes('%0A'), `\\n not encoded: ${data}`);
  });

  it('A8: GITHUB_ACTIONS not set → no output', () => {
    delete process.env.GITHUB_ACTIONS;
    const out = captureStdout(() => emitAnnotations([makeFinding()]));
    assert.equal(out, '');
  });
});

describe('encodeAnnotationProperty', () => {
  it('encodes %, \\r, \\n, :, ,', () => {
    assert.equal(encodeAnnotationProperty('a%b:c,d\r\ne'), 'a%25b%3Ac%2Cd%0D%0Ae');
  });
});

describe('encodeAnnotationData', () => {
  it('encodes %, \\r, \\n but not : or ,', () => {
    assert.equal(encodeAnnotationData('a%b:c,d\r\ne'), 'a%25b:c,d%0D%0Ae');
  });
});
