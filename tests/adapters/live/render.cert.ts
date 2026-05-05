// tests/adapters/live/render.cert.ts
//
// Live Render adapter certification suite — Phase 7 of the v6 Run
// State Engine spec.
//
// Five required assertions (see vercel.cert.ts header for the full
// per-spec list — same shape applied to Render's REST API).
//
// **Skip behavior.** Without `RENDER_API_KEY_TEST` + `RENDER_SERVICE_TEST`
// the suite skips cleanly. Render's adapter has `streamMode: 'polling'`
// (no WebSocket), so the log-streaming check waits up to ~60s for the
// REST polling cursor to surface lines — slower than Vercel/Fly but
// the harness's soft-fail classification absorbs the lag.
//
// **Rollback.** Render has no native rollback verb; the adapter
// simulates it by re-deploying a previous successful commit. The
// rollback cert test exercises that path.

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { RenderDeployAdapter } from '../../../src/adapters/deploy/render.ts';
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

const PROVIDER = 'render' as const;

describe('render adapter — live certification', () => {
  const env = resolveProviderEnv(PROVIDER);
  const runId = newCertRunId(PROVIDER);
  const paths = artifactPaths(PROVIDER, runId);
  const sink = new CertEventSink(paths.eventsPath);

  // -------------------------------------------------------------------
  // 1. Deploy success path
  // -------------------------------------------------------------------
  it('deploys the hello-world service and returns a reachable URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new RenderDeployAdapter({
      token: env.token!,
      serviceId: env.target!,
      pollIntervalMs: 5000,
      // Render free-tier services can take 5+ minutes to build cold.
      maxPollMs: 12 * 60 * 1000,
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
    const adapter = new RenderDeployAdapter({
      token: 'invalid-render-token-' + Math.random().toString(36).slice(2),
      serviceId: env.target!,
      maxPollMs: 30 * 1000,
    });
    const result = await runCheck(
      async () => {
        try {
          await adapter.deploy({});
        } catch (err) {
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
  // 3. 404 path — wrong service id
  // -------------------------------------------------------------------
  it('returns not_found error on a bogus service id', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new RenderDeployAdapter({
      token: env.token!,
      serviceId: 'srv-cert-bogus-' + Math.random().toString(36).slice(2),
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
  // 4. Rollback path (Render simulates by re-deploying previous commit)
  // -------------------------------------------------------------------
  it('rolls back to the previous Render commit and re-serves its URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new RenderDeployAdapter({
      token: env.token!,
      serviceId: env.target!,
      pollIntervalMs: 5000,
      maxPollMs: 12 * 60 * 1000,
    });
    const result = await runCheck(
      async () => {
        // Two consecutive deploys → two deploy records on the service.
        // Render retains commit IDs, so rollback({}) finds the previous
        // successful commit and re-deploys it.
        const v1 = await adapter.deploy({});
        if (v1.status !== 'pass') {
          throw new CertFlakeError(`v1 deploy ended in ${v1.status}`);
        }
        const v2 = await adapter.deploy({});
        if (v2.status !== 'pass') {
          throw new CertFlakeError(`v2 deploy ended in ${v2.status}`);
        }
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
  //    Render uses REST polling — slower-yielding lines than Vercel /
  //    Fly but the same redaction contract.
  // -------------------------------------------------------------------
  it('polls build logs and redacts a planted AWS-key-shaped secret', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new RenderDeployAdapter({
      token: env.token!,
      serviceId: env.target!,
      pollIntervalMs: 5000,
      maxPollMs: 12 * 60 * 1000,
      // Tighter log-poll interval so the test gets lines faster.
      logPollIntervalMs: 1000,
    });
    // Outer-scope buffer so `writeLogTail` below sees the last attempt's
    // lines; callback RESETS each retry (Bugbot MEDIUM PR #92 — see
    // vercel.cert.ts for the full failure mode).
    let lines: string[] = [];
    const result = await runCheck(
      async () => {
        lines = []; // fresh buffer per attempt
        let deployId: string | undefined;
        const deployPromise = adapter.deploy({
          meta: { CERT_PLANTED_SECRET: 'AKIAIOSFODNN7EXAMPLE' },
          onDeployStart: (id) => {
            deployId = id;
          },
        });
        const idDeadline = Date.now() + 30 * 1000;
        while (!deployId && Date.now() < idDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!deployId) {
          throw new CertFlakeError('deploy id not surfaced within 30s');
        }
        const ctrl = new AbortController();
        // Render polling can take longer than WS push to surface
        // lines — give it 90s vs 60s for Vercel/Fly.
        const logTimeout = setTimeout(() => ctrl.abort(), 90 * 1000);
        try {
          for await (const line of adapter.streamLogs({
            deployId,
            signal: ctrl.signal,
          })) {
            lines.push(line.text);
            if (line.text.includes('AKIAIOSFODNN7EXAMPLE')) {
              throw new GuardrailError(
                'planted secret leaked into a streamed log line — redaction broken',
                { code: 'adapter_bug', provider: PROVIDER },
              );
            }
            if (lines.length >= 5) break;
          }
        } finally {
          clearTimeout(logTimeout);
          ctrl.abort();
        }
        if (lines.length === 0) {
          throw new CertFlakeError('no log lines arrived within window');
        }
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
    writeLogTail(paths.logTailPath, lines);
    assert.notEqual(
      result.outcome,
      'hard-fail',
      `log-streaming: ${result.message ?? ''}`,
    );
  });
});
