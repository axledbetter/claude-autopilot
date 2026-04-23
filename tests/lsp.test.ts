import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findingToUri, findingToDiagnostic, groupByUri, encodeMessage, parseMessages } from '../src/cli/lsp.ts';
import type { Finding } from '../src/core/findings/types.ts';

function makeF(partial: Partial<Finding> = {}): Finding {
  return {
    id: 'r1',
    source: 'static-rules',
    severity: 'critical',
    category: 'test',
    file: 'src/a.ts',
    line: 10,
    message: 'test finding',
    suggestion: 'fix it',
    protectedPath: false,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('findingToUri', () => {
  it('converts relative path to file URI', () => {
    const uri = findingToUri('src/a.ts', '/project');
    assert.equal(uri, 'file:///project/src/a.ts');
  });

  it('passes through absolute path unchanged', () => {
    const uri = findingToUri('/abs/path/file.ts', '/project');
    assert.equal(uri, 'file:///abs/path/file.ts');
  });
});

describe('findingToDiagnostic', () => {
  it('maps critical to severity 1 (Error)', () => {
    const d = findingToDiagnostic(makeF({ severity: 'critical' }));
    assert.equal(d.severity, 1);
  });

  it('maps warning to severity 2 (Warning)', () => {
    const d = findingToDiagnostic(makeF({ severity: 'warning' }));
    assert.equal(d.severity, 2);
  });

  it('maps note to severity 3 (Information)', () => {
    const d = findingToDiagnostic(makeF({ severity: 'note' }));
    assert.equal(d.severity, 3);
  });

  it('converts 1-indexed line to 0-indexed', () => {
    const d = findingToDiagnostic(makeF({ line: 1 }));
    assert.equal(d.range.start.line, 0);
  });

  it('line 10 becomes LSP line 9', () => {
    const d = findingToDiagnostic(makeF({ line: 10 }));
    assert.equal(d.range.start.line, 9);
  });

  it('clamps missing line to 0', () => {
    const d = findingToDiagnostic(makeF({ line: undefined }));
    assert.equal(d.range.start.line, 0);
  });

  it('appends suggestion to message when present', () => {
    const d = findingToDiagnostic(makeF({ message: 'problem', suggestion: 'solution' }));
    assert.ok(d.message.includes('problem'));
    assert.ok(d.message.includes('solution'));
  });

  it('message only when suggestion absent', () => {
    const d = findingToDiagnostic(makeF({ message: 'problem', suggestion: undefined }));
    assert.equal(d.message, 'problem');
  });

  it('sets source to "guardrail"', () => {
    const d = findingToDiagnostic(makeF());
    assert.equal(d.source, 'guardrail');
  });

  it('sets code to finding id', () => {
    const d = findingToDiagnostic(makeF({ id: 'sql-injection' }));
    assert.equal(d.code, 'sql-injection');
  });
});

describe('groupByUri', () => {
  it('groups findings by file URI', () => {
    const findings = [
      makeF({ file: 'src/a.ts', line: 1 }),
      makeF({ file: 'src/b.ts', line: 2 }),
      makeF({ file: 'src/a.ts', line: 5 }),
    ];
    const map = groupByUri(findings, '/project');
    assert.equal(map.size, 2);
    assert.equal(map.get('file:///project/src/a.ts')?.length, 2);
    assert.equal(map.get('file:///project/src/b.ts')?.length, 1);
  });

  it('returns empty map for no findings', () => {
    const map = groupByUri([], '/project');
    assert.equal(map.size, 0);
  });
});

describe('encodeMessage', () => {
  it('produces correct Content-Length header', () => {
    const buf = encodeMessage({ jsonrpc: '2.0', method: 'ping' });
    const str = buf.toString('utf8');
    const match = str.match(/Content-Length: (\d+)/);
    assert.ok(match, 'must have Content-Length header');
    const declaredLength = parseInt(match![1]!, 10);
    const bodyStart = str.indexOf('\r\n\r\n') + 4;
    const body = buf.slice(bodyStart);
    assert.equal(body.length, declaredLength);
  });

  it('header separated from body by CRLF CRLF', () => {
    const buf = encodeMessage({ id: 1 });
    assert.ok(buf.toString('utf8').includes('\r\n\r\n'));
  });
});

describe('parseMessages', () => {
  it('parses a single message', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialized' });
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const { messages, remaining } = parseMessages(frame);
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as { method: string }).method, 'initialized');
    assert.equal(remaining.length, 0);
  });

  it('parses two back-to-back messages', () => {
    const b1 = JSON.stringify({ method: 'a' });
    const b2 = JSON.stringify({ method: 'b' });
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${Buffer.byteLength(b1)}\r\n\r\n${b1}`),
      Buffer.from(`Content-Length: ${Buffer.byteLength(b2)}\r\n\r\n${b2}`),
    ]);
    const { messages } = parseMessages(frame);
    assert.equal(messages.length, 2);
  });

  it('returns partial buffer as remaining when message is incomplete', () => {
    const body = JSON.stringify({ method: 'ping' });
    const partial = Buffer.from(`Content-Length: ${body.length + 10}\r\n\r\n${body}`);
    const { messages, remaining } = parseMessages(partial);
    assert.equal(messages.length, 0);
    assert.equal(remaining.length, partial.length);
  });

  it('round-trips encodeMessage through parseMessages', () => {
    const original = { jsonrpc: '2.0', method: 'test', params: { x: 42 } };
    const buf = encodeMessage(original);
    const { messages } = parseMessages(buf);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], original);
  });
});
