import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFingerprint,
  isSameFailure,
  shouldEscalate,
  stripVolatileTokens,
  FINGERPRINT_MESSAGE_MAX,
  type FailureFingerprint,
} from '../../src/core/run-state/sameness-detector.ts';

describe('sameness-detector / computeFingerprint', () => {
  it('produces a 64-char sha256 hex hash', () => {
    const fp = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'Type X is not assignable to type Y',
    });
    assert.equal(fp.hash.length, 64);
    assert.match(fp.hash, /^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same hash', () => {
    const input = {
      phase: 'validate' as const,
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'Type X is not assignable to type Y',
    };
    const a = computeFingerprint(input);
    const b = computeFingerprint(input);
    assert.equal(a.hash, b.hash);
  });

  it('changes hash when phase differs', () => {
    const base = {
      errorType: 'x',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    };
    const a = computeFingerprint({ phase: 'validate', ...base });
    const b = computeFingerprint({ phase: 'codex-review', ...base });
    assert.notEqual(a.hash, b.hash);
  });

  it('changes hash when errorType differs', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    assert.notEqual(a.hash, b.hash);
  });

  it('changes hash when errorLocation differs', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:11',
      errorMessage: 'boom',
    });
    assert.notEqual(a.hash, b.hash);
  });

  it('collapses internal whitespace + trims when computing the message', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: '  Type   X\n\tis\n  not assignable  ',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'Type X is not assignable',
    });
    assert.equal(a.errorMessage, 'Type X is not assignable');
    assert.equal(a.hash, b.hash);
  });

  it('truncates message to FINGERPRINT_MESSAGE_MAX characters', () => {
    const longBody = 'x'.repeat(500);
    const fp = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: longBody,
    });
    assert.equal(fp.errorMessage.length, FINGERPRINT_MESSAGE_MAX);
    assert.equal(fp.errorMessage, 'x'.repeat(FINGERPRINT_MESSAGE_MAX));
  });

  it('treats messages that differ only in trailing noise (past the cap) as equal', () => {
    const head = 'A'.repeat(FINGERPRINT_MESSAGE_MAX);
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: `${head} stack-frame-noise-v1`,
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: `${head} stack-frame-noise-v2-different`,
    });
    assert.equal(a.hash, b.hash);
  });

  it('is delimiter-safe — pipe characters in fields do not collide', () => {
    // Regression: an earlier draft used pipe-delimited concatenation as the
    // pre-hash canonical form. That was vulnerable to:
    //   `a|b|c|d` == `a|b|c|d`  even if fields legitimately contained '|'.
    // The current implementation uses JSON.stringify of a 4-tuple, which is
    // unambiguous. These two inputs should produce DIFFERENT hashes despite
    // the pipe-delimited concatenation being identical.
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'foo|bar',
      errorMessage: 'msg',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error|foo',
      errorLocation: 'bar',
      errorMessage: 'msg',
    });
    assert.notEqual(
      a.hash,
      b.hash,
      'fields with embedded pipes must not produce hash collisions',
    );
  });

  it('handles missing / undefined fields without crashing', () => {
    const fp = computeFingerprint({
      phase: 'validate',
      errorType: '',
      errorLocation: '',
      errorMessage: '',
    });
    assert.equal(fp.errorMessage, '');
    assert.equal(fp.hash.length, 64);
  });

  it('echoes back the phase + normalized fields on the fingerprint', () => {
    const fp = computeFingerprint({
      phase: 'bugbot',
      errorType: 'bugbot_high',
      errorLocation: 'comment-12345',
      errorMessage: 'Hardcoded secret detected',
    });
    assert.equal(fp.phase, 'bugbot');
    assert.equal(fp.errorType, 'bugbot_high');
    assert.equal(fp.errorLocation, 'comment-12345');
    assert.equal(fp.errorMessage, 'Hardcoded secret detected');
  });
});

describe('sameness-detector / stripVolatileTokens', () => {
  it('replaces UUIDs with <uuid>', () => {
    const out = stripVolatileTokens('Failed at request 550e8400-e29b-41d4-a716-446655440000 retry');
    assert.equal(out, 'Failed at request <uuid> retry');
  });

  it('replaces ISO timestamps with <ts>', () => {
    const out = stripVolatileTokens('Error at 2026-05-13T07:00:00.123Z during apply');
    assert.equal(out, 'Error at <ts> during apply');
  });

  it('replaces 13-digit epoch ms with <ts>', () => {
    const out = stripVolatileTokens('run started 1715587200000 ended');
    assert.equal(out, 'run started <ts> ended');
  });

  it('replaces sha1 / sha256 hex digests with <sha>', () => {
    const sha1 = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);
    assert.equal(stripVolatileTokens(`commit ${sha1} ok`), 'commit <sha> ok');
    assert.equal(stripVolatileTokens(`tree ${sha256} ok`), 'tree <sha> ok');
  });

  it('replaces /tmp and /var/folders paths with <tmpdir>', () => {
    assert.equal(
      stripVolatileTokens('Wrote /tmp/abc-XYZ-123/foo.json bytes'),
      'Wrote <tmpdir> bytes',
    );
    assert.equal(
      stripVolatileTokens('cached at /var/folders/9q/abc/T/x.txt now'),
      'cached at <tmpdir> now',
    );
  });

  it('replaces localhost:port with <host:port>', () => {
    assert.equal(
      stripVolatileTokens('connect refused at 127.0.0.1:49213 sock'),
      'connect refused at <host:port> sock',
    );
    assert.equal(
      stripVolatileTokens('connect refused at localhost:49213 sock'),
      'connect refused at <host:port> sock',
    );
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error — testing runtime resilience
    assert.equal(stripVolatileTokens(undefined), '');
    // @ts-expect-error — testing runtime resilience
    assert.equal(stripVolatileTokens(null), '');
  });
});

describe('sameness-detector / fingerprint stability under volatile tokens', () => {
  it('two messages differing only in UUID produce the same hash', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: 'suite > test',
      errorMessage: 'request 550e8400-e29b-41d4-a716-446655440000 timed out',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: 'suite > test',
      errorMessage: 'request 11111111-2222-3333-4444-555555555555 timed out',
    });
    assert.equal(a.hash, b.hash);
  });

  it('two locations differing only in tmpdir path produce the same hash', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: '/tmp/rs-state-AbCdEf/state.json:5',
      errorMessage: 'parse error',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: '/tmp/rs-state-ZyXwVu/state.json:5',
      errorMessage: 'parse error',
    });
    assert.equal(a.hash, b.hash);
  });

  it('two messages differing only in ISO timestamp produce the same hash', () => {
    const a = computeFingerprint({
      phase: 'codex-review',
      errorType: 'codex_critical',
      errorLocation: 'finding-1',
      errorMessage: 'review at 2026-05-13T07:00:00Z failed: missing tenant',
    });
    const b = computeFingerprint({
      phase: 'codex-review',
      errorType: 'codex_critical',
      errorLocation: 'finding-1',
      errorMessage: 'review at 2026-05-13T08:30:42.123Z failed: missing tenant',
    });
    assert.equal(a.hash, b.hash);
  });
});

describe('sameness-detector / isSameFailure', () => {
  it('returns true for two fingerprints with the same hash', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    assert.equal(isSameFailure(a, b), true);
  });

  it('returns false when any identity field differs', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:11',
      errorMessage: 'boom',
    });
    assert.equal(isSameFailure(a, b), false);
  });

  it('returns false for nullish inputs', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'boom',
    });
    // @ts-expect-error — testing runtime resilience
    assert.equal(isSameFailure(a, null), false);
    // @ts-expect-error — testing runtime resilience
    assert.equal(isSameFailure(undefined, a), false);
  });
});

describe('sameness-detector / shouldEscalate — acceptance cases', () => {
  // Acceptance case 1: same fingerprint × 2 → escalate
  it('escalates when last two attempts have identical fingerprints', () => {
    const fp = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'Type X is not assignable to type Y',
    });
    const decision = shouldEscalate([fp, fp]);
    assert.equal(decision.escalate, true);
    assert.ok(decision.reason);
    assert.ok(decision.reason!.includes('validate'));
    assert.ok(decision.reason!.includes('tsc_error'));
    assert.deepEqual(decision.fingerprint, fp);
  });

  // Acceptance case 2: same × 1 (i.e. only one entry) → continue
  it('does NOT escalate when only one failure has been recorded', () => {
    const fp = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'Type X is not assignable to type Y',
    });
    const decision = shouldEscalate([fp]);
    assert.equal(decision.escalate, false);
    assert.equal(decision.fingerprint, undefined);
  });

  // Acceptance case 3: different × 3 → continue (don't escalate just
  // because retries fail independently)
  it('does NOT escalate when three different failures fire in a row', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'first failure',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/bar.ts:20',
      errorMessage: 'second failure',
    });
    const c = computeFingerprint({
      phase: 'validate',
      errorType: 'test_failure',
      errorLocation: 'baz suite > test 1',
      errorMessage: 'third failure',
    });
    const decision = shouldEscalate([a, b, c]);
    assert.equal(decision.escalate, false);
  });
});

describe('sameness-detector / shouldEscalate — edge cases', () => {
  it('does NOT escalate on empty history', () => {
    const decision = shouldEscalate([]);
    assert.equal(decision.escalate, false);
  });

  it('escalates when the last two of a longer history match (even if earlier ones differ)', () => {
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'first attempt failure',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/bar.ts:20',
      errorMessage: 'second attempt failure',
    });
    const c = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/bar.ts:20',
      errorMessage: 'second attempt failure',
    });
    const decision = shouldEscalate([a, b, c]);
    assert.equal(decision.escalate, true);
    assert.deepEqual(decision.fingerprint, c);
  });

  it('does NOT escalate when matching fingerprints are not adjacent (ABA)', () => {
    // The spec is "last 2 are same" — ABA shouldn't trip the detector
    // because the retry between A and the second A WAS different work.
    const a = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'A',
    });
    const b = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/bar.ts:20',
      errorMessage: 'B',
    });
    const aAgain = computeFingerprint({
      phase: 'validate',
      errorType: 'tsc_error',
      errorLocation: 'src/foo.ts:10',
      errorMessage: 'A',
    });
    const decision = shouldEscalate([a, b, aAgain]);
    assert.equal(decision.escalate, false);
  });

  it('works across all three phases (validate / codex-review / bugbot)', () => {
    const phases: Array<FailureFingerprint['phase']> = [
      'validate',
      'codex-review',
      'bugbot',
    ];
    for (const phase of phases) {
      const fp = computeFingerprint({
        phase,
        errorType: 'whatever',
        errorLocation: 'somewhere',
        errorMessage: 'unchanged between retries',
      });
      const decision = shouldEscalate([fp, fp]);
      assert.equal(
        decision.escalate,
        true,
        `expected escalation for phase=${phase}`,
      );
      assert.equal(decision.fingerprint?.phase, phase);
    }
  });
});
