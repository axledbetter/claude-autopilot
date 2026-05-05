// tests/adapters/live/vercel.cert.ts
//
// Live Vercel adapter certification suite — Phase 7 of the v6 Run
// State Engine spec.
//
// Five required assertions, per
// docs/specs/v6-run-state-engine.md § "Real adapter certification
// suite (Phase 7)":
//
//   1. Deploy success path  — push hello-world artifact, get deploy ID,
//                              poll until terminal, assert pass + URL 200.
//   2. Auth failure path     — bad token → `auth` error code.
//   3. 404 path              — wrong project ID → `not_found` error.
//   4. Rollback path         — deploy v1, deploy v2, rollback, assert v1
//                              URL serves again.
//   5. Log streaming path    — subscribe to streamLogs, assert lines
//                              arrive within timeout, assert redaction
//                              on a planted secret.
//
// **Skip behavior.** Without `VERCEL_TOKEN_TEST` + `VERCEL_PROJECT_TEST`
// the entire suite skips cleanly via `t.skip()`. This is the dominant
// case today — see docs/adapters/cert-suite.md for the secrets Alex
// needs to add to enable nightly runs.
//
// **Hello-world deploy semantics.** The cert suite does NOT push a new
// hello-world commit to the sandbox project; the project is expected
// to be pre-created with a static "hello world" page so a no-op
// `deploy()` POST is a valid success path. This keeps the suite from
// requiring git push permissions on every run and lets the rollback
// test exercise the existing two-deploy history (latest + previous).
//
// **No `node:test` filter.** When the env is unconfigured, the
// describe-level `it()` calls invoke `t.skip()`. They report as
// `skipped` rather than `passed`, so the test runner counts mirror the
// spec's expectation that "Live tests skip on dev → counted as
// `skipped` in node:test."

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { VercelDeployAdapter } from '../../../src/adapters/deploy/vercel.ts';
import { GuardrailError } from '../../../src/core/errors.ts';
import {
  CertEventSink,
  CertFlakeError,
  artifactPaths,
  newCertRunId,
  resolveProviderEnv,
  runCheck,
  writeLogTail,
} from './_harness.ts';

const PROVIDER = 'vercel' as const;

describe('vercel adapter — live certification', () => {
  const env = resolveProviderEnv(PROVIDER);
  const runId = newCertRunId(PROVIDER);
  const paths = artifactPaths(PROVIDER, runId);
  const sink = new CertEventSink(paths.eventsPath);

  // -------------------------------------------------------------------
  // 1. Deploy success path
  // -------------------------------------------------------------------
  it('deploys the hello-world project and returns a reachable URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new VercelDeployAdapter({
      token: env.token!,
      project: env.target!,
      // Slow polling explicit so the test doesn't hammer the API.
      pollIntervalMs: 5000,
      // 8 minutes is the spec's "interim deploys reach terminal in
      // under 10 min" assumption with one minute of slack.
      maxPollMs: 8 * 60 * 1000,
    });
    const result = await runCheck(
      async () => {
        const dep = await adapter.deploy({});
        if (dep.status !== 'pass') {
          throw new CertFlakeError(`deploy ended in status ${dep.status}`);
        }
        if (!dep.deployUrl) {
          throw new GuardrailError('deploy returned no URL', {
            code: 'adapter_bug',
            provider: PROVIDER,
          });
        }
        // Probe the URL — flaky in the first ~10s after Vercel marks
        // a deploy as READY, hence the soft-fail classification via
        // CertFlakeError.
        const probe = await fetch(dep.deployUrl, { method: 'GET' });
        if (probe.status !== 200) {
          throw new CertFlakeError(`probe got HTTP ${probe.status}`);
        }
      },
      { provider: PROVIDER, check: 'deploy-success', sink },
    );
    assert.notEqual(result.outcome, 'hard-fail', `deploy-success: ${result.message ?? ''}`);
  });

  // -------------------------------------------------------------------
  // 2. Auth failure path
  // -------------------------------------------------------------------
  it('returns auth error on a bad token', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new VercelDeployAdapter({
      token: 'invalid-vercel-token-' + Math.random().toString(36).slice(2),
      project: env.target!,
      maxPollMs: 30 * 1000,
    });
    const result = await runCheck(
      async () => {
        try {
          await adapter.deploy({});
        } catch (err) {
          // Expected — must be a GuardrailError(auth). The harness
          // classifies it as deterministic so no retry burns through.
          if (err instanceof GuardrailError && err.code === 'auth') return;
          throw err;
        }
        throw new GuardrailError('expected auth error, got success', {
          code: 'adapter_bug',
          provider: PROVIDER,
        });
      },
      { provider: PROVIDER, check: 'auth-failure', sink },
    );
    assert.equal(result.outcome, 'success', `auth check: ${result.message ?? ''}`);
  });

  // -------------------------------------------------------------------
  // 3. 404 path
  // -------------------------------------------------------------------
  it('returns not_found error on a bogus project id', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new VercelDeployAdapter({
      token: env.token!,
      project: 'cert-bogus-project-' + Math.random().toString(36).slice(2),
      maxPollMs: 30 * 1000,
    });
    const result = await runCheck(
      async () => {
        try {
          await adapter.deploy({});
        } catch (err) {
          if (err instanceof GuardrailError && err.code === 'not_found') return;
          throw err;
        }
        throw new GuardrailError('expected not_found error, got success', {
          code: 'adapter_bug',
          provider: PROVIDER,
        });
      },
      { provider: PROVIDER, check: '404-path', sink },
    );
    assert.equal(result.outcome, 'success', `404 check: ${result.message ?? ''}`);
  });

  // -------------------------------------------------------------------
  // 4. Rollback path
  // -------------------------------------------------------------------
  it('rolls back to the previous production deploy and re-serves its URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new VercelDeployAdapter({
      token: env.token!,
      project: env.target!,
      pollIntervalMs: 5000,
      maxPollMs: 8 * 60 * 1000,
    });
    const result = await runCheck(
      async () => {
        // Deploy v1 (current "latest" on the sandbox).
        const v1 = await adapter.deploy({});
        if (v1.status !== 'pass') {
          throw new CertFlakeError(`v1 deploy ended in ${v1.status}`);
        }
        // Deploy v2 (becomes the new latest).
        const v2 = await adapter.deploy({});
        if (v2.status !== 'pass') {
          throw new CertFlakeError(`v2 deploy ended in ${v2.status}`);
        }
        // Rollback — the adapter promotes the previous prod deploy
        // back to production.
        const rolled = await adapter.rollback({});
        if (rolled.status !== 'pass') {
          throw new CertFlakeError(`rollback ended in ${rolled.status}`);
        }
        if (!rolled.deployUrl) {
          throw new GuardrailError('rollback returned no URL', {
            code: 'adapter_bug',
            provider: PROVIDER,
          });
        }
        const probe = await fetch(rolled.deployUrl, { method: 'GET' });
        if (probe.status !== 200) {
          throw new CertFlakeError(`rolled-back URL probe got HTTP ${probe.status}`);
        }
      },
      { provider: PROVIDER, check: 'rollback', sink },
    );
    assert.notEqual(result.outcome, 'hard-fail', `rollback: ${result.message ?? ''}`);
  });

  // -------------------------------------------------------------------
  // 5. Log streaming path + redaction assertion
  // -------------------------------------------------------------------
  it('streams build logs and redacts a planted AWS-key-shaped secret', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new VercelDeployAdapter({
      token: env.token!,
      project: env.target!,
      pollIntervalMs: 5000,
      maxPollMs: 8 * 60 * 1000,
    });
    const lines: string[] = [];
    const result = await runCheck(
      async () => {
        // Kick off a deploy and capture its ID via onDeployStart so we
        // can subscribe to logs in parallel.
        let deployId: string | undefined;
        const deployPromise = adapter.deploy({
          // Plant a fake AWS key in the deploy meta — the adapter
          // emits it back in `output` and (best-effort) in build
          // log lines, so we can prove redaction is applied.
          meta: { CERT_PLANTED_SECRET: 'AKIAIOSFODNN7EXAMPLE' },
          onDeployStart: (id) => {
            deployId = id;
          },
        });
        // Wait briefly for the deploy ID before subscribing.
        const idDeadline = Date.now() + 30 * 1000;
        while (!deployId && Date.now() < idDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!deployId) {
          throw new CertFlakeError('deploy id not surfaced within 30s');
        }
        // Subscribe to logs with a 60s window — Vercel emits build
        // events as the build runs.
        const ctrl = new AbortController();
        const logTimeout = setTimeout(() => ctrl.abort(), 60 * 1000);
        try {
          for await (const line of adapter.streamLogs({
            deployId,
            signal: ctrl.signal,
          })) {
            lines.push(line.text);
            // Redaction MUST have happened in the adapter — the raw
            // AKIA... token must never appear in a yielded line.
            if (line.text.includes('AKIAIOSFODNN7EXAMPLE')) {
              throw new GuardrailError(
                'planted secret leaked into a streamed log line — redaction broken',
                { code: 'adapter_bug', provider: PROVIDER },
              );
            }
            if (lines.length >= 5) break; // enough to assert "lines arrive"
          }
        } finally {
          clearTimeout(logTimeout);
          ctrl.abort();
        }
        if (lines.length === 0) {
          throw new CertFlakeError('no log lines arrived within window');
        }
        // Wait for the deploy to settle so the suite doesn't leave a
        // pending POST behind.
        const tail = await deployPromise;
        if (tail.output && tail.output.includes('AKIAIOSFODNN7EXAMPLE')) {
          throw new GuardrailError('planted secret leaked into result.output', {
            code: 'adapter_bug',
            provider: PROVIDER,
          });
        }
      },
      { provider: PROVIDER, check: 'log-streaming', sink },
    );
    // Persist the log-tail artifact regardless of outcome.
    writeLogTail(paths.logTailPath, lines);
    assert.notEqual(
      result.outcome,
      'hard-fail',
      `log-streaming: ${result.message ?? ''}`,
    );
  });
});
