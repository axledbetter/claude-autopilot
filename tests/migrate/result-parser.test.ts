// tests/migrate/result-parser.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseResult,
  parseResultFromStdout,
  parseResultFromFile,
} from '../../src/core/migrate/result-parser.ts';

const VALID_NONCE = 'a'.repeat(64);
const VALID_INVOCATION_ID = '12345678-1234-4234-8234-123456789012';

const VALID_ARTIFACT = {
  contractVersion: '1.0',
  skillId: 'migrate@1',
  invocationId: VALID_INVOCATION_ID,
  nonce: VALID_NONCE,
  status: 'applied',
  reasonCode: 'ok',
  appliedMigrations: ['20260429_foo.sql'],
  destructiveDetected: false,
  sideEffectsPerformed: ['migration-ledger-updated'],
  nextActions: ['regenerate-types'],
};

function tmpFile(content: string): string {
  const p = path.join(os.tmpdir(), `result-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(p, content);
  return p;
}

describe('parseResultFromFile', () => {
  it('parses a valid artifact', () => {
    const file = tmpFile(JSON.stringify(VALID_ARTIFACT));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'applied');
    assert.equal(r.skillId, 'migrate@1');
    fs.unlinkSync(file);
  });

  it('rejects when nonce mismatches expected', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, nonce: 'b'.repeat(64) }));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'nonce-mismatch');
    fs.unlinkSync(file);
  });

  it('rejects when invocationId mismatches expected', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, invocationId: 'other-id' }));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'invocationId-mismatch');
    fs.unlinkSync(file);
  });

  it('rejects oversized output (>1 MB)', () => {
    const oversized = { ...VALID_ARTIFACT, reasonCode: 'x'.repeat(2_000_000) };
    const file = tmpFile(JSON.stringify(oversized));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-too-large');
    fs.unlinkSync(file);
  });

  it('rejects missing required field', () => {
    const partial = { ...VALID_ARTIFACT };
    delete (partial as Record<string, unknown>)['skillId'];
    const file = tmpFile(JSON.stringify(partial));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'invalid-result-artifact');
    fs.unlinkSync(file);
  });

  it('rejects invalid status enum', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, status: 'whatever' }));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'invalid-result-artifact');
    fs.unlinkSync(file);
  });

  it('ignores unknown fields (forward compat for minor versions)', () => {
    const withExtra = { ...VALID_ARTIFACT, futureField: 'foo' };
    const file = tmpFile(JSON.stringify(withExtra));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'applied');
  });

  it('rejects unknown major contract version', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, contractVersion: '2.0' }));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'unsupported-contract-version');
    fs.unlinkSync(file);
  });

  it('rejects when file does not exist', () => {
    const r = parseResultFromFile('/nonexistent/path.json', { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-file-missing');
  });

  it('rejects malformed JSON', () => {
    const file = tmpFile('{not json}');
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'invalid-result-artifact');
    fs.unlinkSync(file);
  });

  it('rejects unreserved sideEffectsPerformed values', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, sideEffectsPerformed: ['something-invented'] }));
    const r = parseResultFromFile(file, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'invalid-result-artifact');
    fs.unlinkSync(file);
  });
});

describe('parseResultFromStdout (opt-in fallback)', () => {
  function wrap(artifact: object, nonceForMarker: string): string {
    return [
      'some prior output',
      `@@AUTOPILOT_RESULT_BEGIN:${nonceForMarker}@@`,
      JSON.stringify(artifact),
      `@@AUTOPILOT_RESULT_END:${nonceForMarker}@@`,
      'trailing logs',
    ].join('\n');
  }

  it('parses valid stdout with matching nonce markers', () => {
    const stdout = wrap(VALID_ARTIFACT, VALID_NONCE);
    const r = parseResultFromStdout(stdout, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'applied');
  });

  it('rejects when marker nonce differs from expected', () => {
    const stdout = wrap(VALID_ARTIFACT, 'c'.repeat(64));
    const r = parseResultFromStdout(stdout, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-not-found-in-stdout');
  });

  it('rejects truncated output (missing END marker)', () => {
    const stdout = `@@AUTOPILOT_RESULT_BEGIN:${VALID_NONCE}@@\n${JSON.stringify(VALID_ARTIFACT)}`;
    const r = parseResultFromStdout(stdout, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-truncated');
  });

  it('rejects when no markers found at all', () => {
    const r = parseResultFromStdout('plain output, no markers', { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-not-found-in-stdout');
  });
});

describe('parseResultFromFile — TOCTOU hardening', () => {
  it('rejects symlink target as result file (Unix only)', () => {
    if (process.platform === 'win32') return;
    const real = tmpFile(JSON.stringify(VALID_ARTIFACT));
    const sym = path.join(os.tmpdir(), `sym-${Date.now()}-${Math.random()}.json`);
    fs.symlinkSync(real, sym);
    const r = parseResultFromFile(sym, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-file-not-regular');
    fs.unlinkSync(sym);
    fs.unlinkSync(real);
  });

  it('rejects path that points at a directory (not a regular file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-dir-'));
    const r = parseResultFromFile(dir, { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-file-not-regular');
    fs.rmSync(dir, { recursive: true });
  });
  // Note: owner-mismatch test is hard to construct portably (requires
  // creating a file owned by a different uid) — skipped.
});

describe('parseResult (file first, stdout fallback per allowStdoutFallback flag)', () => {
  it('prefers file when both file and stdout are valid', () => {
    const file = tmpFile(JSON.stringify({ ...VALID_ARTIFACT, reasonCode: 'from-file' }));
    const stdout = `@@AUTOPILOT_RESULT_BEGIN:${VALID_NONCE}@@\n${JSON.stringify({ ...VALID_ARTIFACT, reasonCode: 'from-stdout' })}\n@@AUTOPILOT_RESULT_END:${VALID_NONCE}@@`;
    const r = parseResult({
      filePath: file,
      stdout,
      expected: { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE },
      allowStdoutFallback: true,
    });
    assert.equal(r.reasonCode, 'from-file');
    fs.unlinkSync(file);
  });

  it('falls back to stdout when file is missing AND fallback enabled', () => {
    const stdout = `@@AUTOPILOT_RESULT_BEGIN:${VALID_NONCE}@@\n${JSON.stringify(VALID_ARTIFACT)}\n@@AUTOPILOT_RESULT_END:${VALID_NONCE}@@`;
    const r = parseResult({
      filePath: '/nonexistent.json',
      stdout,
      expected: { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE },
      allowStdoutFallback: true,
    });
    assert.equal(r.status, 'applied');
  });

  it('errors with result-file-missing when file absent and fallback disabled', () => {
    const r = parseResult({
      filePath: '/nonexistent.json',
      stdout: `@@AUTOPILOT_RESULT_BEGIN:${VALID_NONCE}@@\n${JSON.stringify(VALID_ARTIFACT)}\n@@AUTOPILOT_RESULT_END:${VALID_NONCE}@@`,
      expected: { invocationId: VALID_INVOCATION_ID, nonce: VALID_NONCE },
      allowStdoutFallback: false,
    });
    assert.equal(r.status, 'error');
    assert.equal(r.reasonCode, 'result-file-missing');
  });
});
