// tests/adapters/live/_harness.test.ts
//
// Unit tests for the Phase 7 live-cert harness. These run under the
// regular `npm test` (no live credentials required) so the gating /
// retry / soft-fail logic is verified on every push, not just on the
// nightly cert workflow.
//
// Spec: docs/specs/v6-run-state-engine.md § "Real adapter
// certification suite (Phase 7)" — flake-control NOTE block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  artifactPaths,
  CertEventSink,
  CertFlakeError,
  classifyError,
  MAX_ATTEMPTS,
  newCertRunId,
  PROVIDER_TARGET_ENV,
  PROVIDER_TOKEN_ENV,
  resolveArtifactRoot,
  resolveProviderEnv,
  RETRY_BACKOFF_MS,
  runCheck,
  SoftFailCounter,
  SOFT_FAIL_ESCALATION_THRESHOLD,
  workflowExitCode,
  writeLogTail,
} from './_harness.ts';
import { GuardrailError } from '../../../src/core/errors.ts';

const sleepNoop = async () => {};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cert-harness-'));
}

// ---------------------------------------------------------------------------
// Skip-mode detection
// ---------------------------------------------------------------------------

describe('resolveProviderEnv — skip-mode detection', () => {
  it('marks the provider as not-ready when both env vars are missing', () => {
    // Empty env is the dominant case on dev machines today. The
    // assertion guards the "no live creds = clean skip" contract that
    // every cert test depends on.
    const env = resolveProviderEnv('vercel', {});
    assert.equal(env.ready, false);
    assert.equal(env.hasToken, false);
    assert.equal(env.hasTarget, false);
    assert.equal(env.token, undefined);
    assert.equal(env.target, undefined);
    assert.match(env.reason, /VERCEL_TOKEN_TEST/);
    assert.match(env.reason, /VERCEL_PROJECT_TEST/);
    assert.match(env.reason, /skipped/);
  });

  it('marks the provider as ready when both env vars are set', () => {
    const env = resolveProviderEnv('vercel', {
      VERCEL_TOKEN_TEST: 'tok_test',
      VERCEL_PROJECT_TEST: 'prj_test',
    });
    assert.equal(env.ready, true);
    assert.equal(env.hasToken, true);
    assert.equal(env.hasTarget, true);
    assert.equal(env.token, 'tok_test');
    assert.equal(env.target, 'prj_test');
    assert.match(env.reason, /running live cert against sandbox/);
  });

  it('flags the partial-config case where only the token is set', () => {
    // This is the most likely operator mistake — secret added but
    // no target id. The skip message must mention the *missing*
    // env var by name so the operator can fix it without grepping.
    const env = resolveProviderEnv('fly', { FLY_API_TOKEN_TEST: 'tok' });
    assert.equal(env.ready, false);
    assert.equal(env.hasToken, true);
    assert.equal(env.hasTarget, false);
    assert.match(env.reason, /FLY_APP_TEST not set/);
  });

  it('flags the partial-config case where only the target id is set', () => {
    const env = resolveProviderEnv('render', { RENDER_SERVICE_TEST: 'srv' });
    assert.equal(env.ready, false);
    assert.equal(env.hasToken, false);
    assert.equal(env.hasTarget, true);
    assert.match(env.reason, /RENDER_API_KEY_TEST not set/);
  });

  it('treats empty-string env vars as missing', () => {
    // Bash exports `FOO=` as a present-but-empty env var. The
    // harness must not be tricked into thinking that's a real token.
    const env = resolveProviderEnv('vercel', {
      VERCEL_TOKEN_TEST: '',
      VERCEL_PROJECT_TEST: '',
    });
    assert.equal(env.ready, false);
  });

  it('exposes a stable per-provider env-name table', () => {
    // The workflow YAML, the docs, and the harness all key off these
    // names. The test pins them so a rename is a deliberate, visible
    // change.
    assert.deepEqual(PROVIDER_TOKEN_ENV, {
      vercel: 'VERCEL_TOKEN_TEST',
      fly: 'FLY_API_TOKEN_TEST',
      render: 'RENDER_API_KEY_TEST',
    });
    assert.deepEqual(PROVIDER_TARGET_ENV, {
      vercel: 'VERCEL_PROJECT_TEST',
      fly: 'FLY_APP_TEST',
      render: 'RENDER_SERVICE_TEST',
    });
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('classifyError — failure category mapping', () => {
  it('classifies GuardrailError(auth) as deterministic', () => {
    const err = new GuardrailError('bad token', { code: 'auth', provider: 'vercel' });
    assert.equal(classifyError(err), 'deterministic');
  });

  it('classifies GuardrailError(not_found) as deterministic', () => {
    const err = new GuardrailError('no such project', { code: 'not_found', provider: 'vercel' });
    assert.equal(classifyError(err), 'deterministic');
  });

  it('classifies GuardrailError(invalid_config) as deterministic', () => {
    const err = new GuardrailError('schema mismatch', { code: 'invalid_config', provider: 'fly' });
    assert.equal(classifyError(err), 'deterministic');
  });

  it('classifies GuardrailError(rate_limit) as transient', () => {
    const err = new GuardrailError('429', { code: 'rate_limit', provider: 'render' });
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies GuardrailError(transient_network) as transient', () => {
    const err = new GuardrailError('ECONNRESET', { code: 'transient_network', provider: 'fly' });
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies CertFlakeError as flaky', () => {
    assert.equal(classifyError(new CertFlakeError('log lines never arrived')), 'flaky');
  });

  it('classifies an unknown plain Error as unknown (fail-fast)', () => {
    // Per the harness contract: unknown failures don't burn the retry
    // budget. They go straight to hard-fail so a triage engineer
    // sees them without log noise.
    assert.equal(classifyError(new Error('???')), 'unknown');
  });

  it('classifies an unrecognized GuardrailError code as unknown', () => {
    const err = new GuardrailError('budget', { code: 'budget_exceeded', provider: 'vercel' });
    assert.equal(classifyError(err), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Soft-fail counter
// ---------------------------------------------------------------------------

describe('SoftFailCounter — escalation accounting', () => {
  it('starts at zero for a fresh provider+check tuple', () => {
    const c = new SoftFailCounter();
    assert.equal(c.get('vercel', 'log-streaming'), 0);
  });

  it('increments by one per recordSoftFail call', () => {
    const c = new SoftFailCounter();
    assert.equal(c.recordSoftFail('vercel', 'log-streaming'), 1);
    assert.equal(c.recordSoftFail('vercel', 'log-streaming'), 2);
    assert.equal(c.recordSoftFail('vercel', 'log-streaming'), 3);
  });

  it('keeps separate counters per provider', () => {
    const c = new SoftFailCounter();
    c.recordSoftFail('vercel', 'log-streaming');
    c.recordSoftFail('fly', 'log-streaming');
    assert.equal(c.get('vercel', 'log-streaming'), 1);
    assert.equal(c.get('fly', 'log-streaming'), 1);
    assert.equal(c.get('render', 'log-streaming'), 0);
  });

  it('keeps separate counters per check name', () => {
    const c = new SoftFailCounter();
    c.recordSoftFail('vercel', 'log-streaming');
    c.recordSoftFail('vercel', 'rollback');
    assert.equal(c.get('vercel', 'log-streaming'), 1);
    assert.equal(c.get('vercel', 'rollback'), 1);
  });

  it('resets a counter on recordSuccess', () => {
    const c = new SoftFailCounter();
    c.recordSoftFail('vercel', 'log-streaming');
    c.recordSoftFail('vercel', 'log-streaming');
    c.recordSuccess('vercel', 'log-streaming');
    assert.equal(c.get('vercel', 'log-streaming'), 0);
  });

  it('reset() clears all tuples (test-only convenience)', () => {
    const c = new SoftFailCounter();
    c.recordSoftFail('vercel', 'a');
    c.recordSoftFail('fly', 'b');
    c.reset();
    assert.equal(c.get('vercel', 'a'), 0);
    assert.equal(c.get('fly', 'b'), 0);
  });
});

// ---------------------------------------------------------------------------
// Retry budget + soft-fail escalation through runCheck
// ---------------------------------------------------------------------------

describe('runCheck — retry budget + flake control', () => {
  it('returns success on the first try when fn resolves', async () => {
    const counter = new SoftFailCounter();
    const result = await runCheck(async () => {}, {
      provider: 'vercel',
      check: 'happy-path',
      counter,
      sleepImpl: sleepNoop,
    });
    assert.equal(result.outcome, 'success');
    assert.equal(result.attempts, 1);
  });

  it('hard-fails immediately on a deterministic GuardrailError(auth) — no retry', async () => {
    // Per spec: "Hard-fail (no retry) for deterministic checks:
    // auth-error, 404, schema mismatch." This is the most important
    // single-test invariant — auth errors must not burn the retry
    // budget while we wait 21 seconds for nothing.
    const counter = new SoftFailCounter();
    let calls = 0;
    const result = await runCheck(
      async () => {
        calls++;
        throw new GuardrailError('bad token', { code: 'auth', provider: 'vercel' });
      },
      {
        provider: 'vercel',
        check: 'auth-failure',
        counter,
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'hard-fail');
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1, 'auth errors must not retry');
    assert.equal(result.category, 'deterministic');
  });

  it('hard-fails immediately on a deterministic GuardrailError(not_found)', async () => {
    let calls = 0;
    const result = await runCheck(
      async () => {
        calls++;
        throw new GuardrailError('no such project', {
          code: 'not_found',
          provider: 'vercel',
        });
      },
      {
        provider: 'vercel',
        check: '404-path',
        counter: new SoftFailCounter(),
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'hard-fail');
    assert.equal(calls, 1);
  });

  it('retries a transient error up to MAX_ATTEMPTS times then soft-fails', async () => {
    const counter = new SoftFailCounter();
    let calls = 0;
    const result = await runCheck(
      async () => {
        calls++;
        throw new GuardrailError('5xx', { code: 'transient_network', provider: 'fly' });
      },
      {
        provider: 'fly',
        check: 'transient-loop',
        counter,
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'soft-fail');
    assert.equal(result.attempts, MAX_ATTEMPTS);
    assert.equal(calls, MAX_ATTEMPTS);
    assert.equal(counter.get('fly', 'transient-loop'), 1);
  });

  it('succeeds on the second attempt when a transient error clears', async () => {
    const counter = new SoftFailCounter();
    let calls = 0;
    const result = await runCheck(
      async () => {
        calls++;
        if (calls < 2) {
          throw new GuardrailError('5xx', {
            code: 'transient_network',
            provider: 'fly',
          });
        }
      },
      {
        provider: 'fly',
        check: 'transient-recovers',
        counter,
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'success');
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(counter.get('fly', 'transient-recovers'), 0, 'success clears the counter');
  });

  it('retries a flaky error and soft-fails on exhaustion', async () => {
    const counter = new SoftFailCounter();
    const result = await runCheck(
      async () => {
        throw new CertFlakeError('log lines never arrived in window');
      },
      {
        provider: 'render',
        check: 'log-streaming',
        counter,
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'soft-fail');
    assert.equal(result.category, 'flaky');
    assert.equal(counter.get('render', 'log-streaming'), 1);
  });

  it(`escalates to hard-fail after ${SOFT_FAIL_ESCALATION_THRESHOLD} consecutive soft-fails on the same check`, async () => {
    // The most subtle bit of the harness: three soft-fails in a
    // row promotes to hard-fail. Any single success between them
    // resets the counter (covered by the next test).
    const counter = new SoftFailCounter();
    const opts = {
      provider: 'render' as const,
      check: 'flaky-rollout',
      counter,
      sleepImpl: sleepNoop,
    };
    const fail = async () => {
      throw new CertFlakeError('rollout race');
    };

    const a = await runCheck(fail, opts);
    assert.equal(a.outcome, 'soft-fail');
    const b = await runCheck(fail, opts);
    assert.equal(b.outcome, 'soft-fail');
    const c = await runCheck(fail, opts);
    // Third strike — escalated.
    assert.equal(c.outcome, 'hard-fail');
    assert.match(c.message ?? '', /escalated to hard-fail/);
    assert.match(c.message ?? '', /3 consecutive/);
  });

  it('clears the consecutive-fail counter after a single success', async () => {
    // Critical: the spec says "after three *consecutive* soft-fails".
    // A success between two soft-fails must reset the counter so we
    // don't auto-escalate on the next bad cycle.
    const counter = new SoftFailCounter();
    const opts = {
      provider: 'fly' as const,
      check: 'mixed-results',
      counter,
      sleepImpl: sleepNoop,
    };
    const fail = async () => {
      throw new CertFlakeError('flake');
    };
    const ok = async () => {};

    await runCheck(fail, opts);
    await runCheck(fail, opts);
    assert.equal(counter.get('fly', 'mixed-results'), 2);

    await runCheck(ok, opts);
    assert.equal(counter.get('fly', 'mixed-results'), 0, 'success resets');

    // Now two more flakes shouldn't escalate (only 2 consecutive).
    const x = await runCheck(fail, opts);
    assert.equal(x.outcome, 'soft-fail');
    const y = await runCheck(fail, opts);
    assert.equal(y.outcome, 'soft-fail', 'still under the threshold');
  });

  it('treats unknown errors (plain Error) as deterministic — no retry', async () => {
    let calls = 0;
    const result = await runCheck(
      async () => {
        calls++;
        throw new Error('???');
      },
      {
        provider: 'vercel',
        check: 'unknown-path',
        counter: new SoftFailCounter(),
        sleepImpl: sleepNoop,
      },
    );
    assert.equal(result.outcome, 'hard-fail');
    assert.equal(calls, 1, 'unknown errors must not retry');
    assert.equal(result.category, 'unknown');
  });

  it('exposes the configured backoff schedule (1s / 4s / 16s)', () => {
    // Per spec NOTE: "Per-provider retry budget: 3 attempts with
    // exp backoff (1s / 4s / 16s) on transient categories."
    // Pinning the table here makes a schedule change a deliberate
    // diff that touches the test suite.
    assert.deepEqual([...RETRY_BACKOFF_MS], [1000, 4000, 16000]);
    assert.equal(MAX_ATTEMPTS, 3);
    assert.equal(SOFT_FAIL_ESCALATION_THRESHOLD, 3);
  });

  it('writes attempt+success events to the NDJSON sink', async () => {
    const dir = tmpdir();
    const eventsPath = path.join(dir, 'events.ndjson');
    const sink = new CertEventSink(eventsPath);
    await runCheck(async () => {}, {
      provider: 'vercel',
      check: 'event-trace',
      sink,
      counter: new SoftFailCounter(),
      sleepImpl: sleepNoop,
    });
    const events = sink.readAll();
    assert.deepEqual(
      events.map((e) => e.event),
      ['check.start', 'check.attempt', 'check.success'],
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes hard-fail event to the NDJSON sink on auth error', async () => {
    const dir = tmpdir();
    const eventsPath = path.join(dir, 'events.ndjson');
    const sink = new CertEventSink(eventsPath);
    await runCheck(
      async () => {
        throw new GuardrailError('bad token', { code: 'auth', provider: 'vercel' });
      },
      {
        provider: 'vercel',
        check: 'auth-trace',
        sink,
        counter: new SoftFailCounter(),
        sleepImpl: sleepNoop,
      },
    );
    const events = sink.readAll();
    assert.equal(events.at(-1)?.event, 'check.hard-fail');
    const hardFail = events.at(-1) as Extract<(typeof events)[number], { event: 'check.hard-fail' }>;
    assert.equal(hardFail.category, 'deterministic');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Artifact path generation
// ---------------------------------------------------------------------------

describe('artifact paths + log tail persistence', () => {
  it('resolves the artifact root from ADAPTER_CERT_ARTIFACT_DIR when set', () => {
    const root = resolveArtifactRoot({ ADAPTER_CERT_ARTIFACT_DIR: '/tmp/ci-artifacts' });
    assert.equal(root, '/tmp/ci-artifacts');
  });

  it('falls back to <cwd>/artifacts/adapter-cert when env is absent', () => {
    const root = resolveArtifactRoot({});
    assert.ok(root.endsWith(path.join('artifacts', 'adapter-cert')));
  });

  it('builds a deterministic path tree per provider+runId', () => {
    const paths = artifactPaths('vercel', 'run-abc', { ADAPTER_CERT_ARTIFACT_DIR: '/tmp/x' });
    assert.equal(paths.runDir, path.join('/tmp/x', 'vercel', 'run-abc'));
    assert.equal(paths.eventsPath, path.join('/tmp/x', 'vercel', 'run-abc', 'events.ndjson'));
    assert.equal(paths.logTailPath, path.join('/tmp/x', 'vercel', 'run-abc', 'log-tail.txt'));
  });

  it('newCertRunId is sortable + provider-prefixed', () => {
    // Two consecutive ids should compare in chronological order
    // because the leading timestamp wins lexically.
    const a = newCertRunId('vercel', '2026-05-05T00:00:00.000Z');
    const b = newCertRunId('vercel', '2026-05-05T00:00:01.000Z');
    assert.ok(a < b, `expected ${a} < ${b}`);
    assert.match(a, /vercel/);
  });

  it('writeLogTail truncates to the last N lines and writes them to disk', () => {
    const dir = tmpdir();
    const logPath = path.join(dir, 'log-tail.txt');
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    writeLogTail(logPath, lines, 200);
    const written = fs.readFileSync(logPath, 'utf8').split('\n');
    assert.equal(written.length, 200);
    assert.equal(written[0], 'line 51');
    assert.equal(written.at(-1), 'line 250');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeLogTail handles fewer-than-max lines without padding', () => {
    const dir = tmpdir();
    const logPath = path.join(dir, 'log-tail.txt');
    writeLogTail(logPath, ['a', 'b', 'c'], 200);
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'a\nb\nc');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Workflow exit code
// ---------------------------------------------------------------------------

describe('workflowExitCode — soft-fail tolerance', () => {
  it('returns 0 when every result is success', () => {
    assert.equal(
      workflowExitCode([
        { outcome: 'success', attempts: 1, durationMs: 10 },
        { outcome: 'success', attempts: 1, durationMs: 10 },
      ]),
      0,
    );
  });

  it('returns 0 when results contain only soft-fails (alert, do not break)', () => {
    // Per spec NOTE: "Soft-fail with alert: log a warning + alert
    // channel ping but don't break the workflow run." The CI exit
    // code therefore tolerates soft-fails while still surfacing them
    // via the NDJSON events.
    assert.equal(
      workflowExitCode([
        { outcome: 'soft-fail', attempts: 3, durationMs: 21000, category: 'flaky', message: 'flake' },
        { outcome: 'success', attempts: 1, durationMs: 50 },
      ]),
      0,
    );
  });

  it('returns 1 when any result is a hard-fail', () => {
    assert.equal(
      workflowExitCode([
        { outcome: 'success', attempts: 1, durationMs: 10 },
        { outcome: 'hard-fail', attempts: 1, durationMs: 5, category: 'deterministic', message: 'auth' },
      ]),
      1,
    );
  });

  it('returns 0 for an empty result list (no checks ran — env-skip)', () => {
    // When the cert suite skips entirely (no creds), no results are
    // collected. Treat that as workflow-pass — the suite did its job
    // by skipping cleanly.
    assert.equal(workflowExitCode([]), 0);
  });
});
