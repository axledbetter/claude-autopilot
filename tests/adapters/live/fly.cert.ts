// tests/adapters/live/fly.cert.ts
//
// Live Fly adapter certification suite — Phase 7 of the v6 Run State
// Engine spec.
//
// Five required assertions (see vercel.cert.ts header for the full
// per-spec list — same shape applied to Fly's API).
//
// **Skip behavior.** Without `FLY_API_TOKEN_TEST` + `FLY_APP_TEST`
// the suite skips cleanly. Additionally requires `FLY_IMAGE_TEST` to
// be set to a pre-pushed registry image (e.g.
// `registry.fly.io/<app>:cert-hello-world`); without it the deploy
// + rollback + log-streaming tests skip with a descriptive message,
// while the auth + 404 paths still run because they don't need the
// image.
//
// Why pre-pushed images: the Fly adapter doesn't build images itself
// (per the v5.6 spec), so the cert suite assumes the operator pushed
// `cert-hello-world` once during sandbox setup. Re-pushing on every
// nightly run would require either a build host inside the workflow
// or a webhook to a Fly builder — both add complexity for no
// reliability benefit.

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { FlyDeployAdapter } from '../../../src/adapters/deploy/fly.ts';
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

const PROVIDER = 'fly' as const;
const IMAGE_ENV = 'FLY_IMAGE_TEST';

describe('fly adapter — live certification', () => {
  const env = resolveProviderEnv(PROVIDER);
  const image = process.env[IMAGE_ENV];
  const hasImage = typeof image === 'string' && image.length > 0;
  const imageSkipReason = `${IMAGE_ENV} not set — Fly cert needs a pre-pushed registry image (see docs/adapters/cert-suite.md for the one-time push)`;

  const runId = newCertRunId(PROVIDER);
  const paths = artifactPaths(PROVIDER, runId);
  const sink = new CertEventSink(paths.eventsPath);

  // -------------------------------------------------------------------
  // 1. Deploy success path
  // -------------------------------------------------------------------
  it('deploys the hello-world image and returns a reachable URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    if (!hasImage) {
      t.skip(imageSkipReason);
      return;
    }
    const adapter = new FlyDeployAdapter({
      token: env.token!,
      app: env.target!,
      image: image!,
      pollIntervalMs: 5000,
      maxPollMs: 8 * 60 * 1000,
    });
    const result = await runCheck(
      async () => {
        const dep = await adapter.deploy({});
        if (dep.status !== 'pass') {
          throw new CertFlakeError(`deploy ended in status ${dep.status}`);
        }
        if (!dep.deployUrl) {
          // Fly app URL is conventionally https://<app>.fly.dev — adapter
          // populates it when the platform reports it. Treat absence as
          // soft-fail since some Fly apps are private.
          throw new CertFlakeError('deploy returned no URL (private app?)');
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
  // 2. Auth failure path — does NOT need a real image; constructor
  //    requires `image` so we pass a placeholder that never gets used
  //    (the auth check fails on the first POST).
  // -------------------------------------------------------------------
  it('returns auth error on a bad token', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new FlyDeployAdapter({
      token: 'invalid-fly-token-' + Math.random().toString(36).slice(2),
      app: env.target!,
      image: 'registry.fly.io/cert/never-used:latest',
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
  // 3. 404 path — wrong app slug
  // -------------------------------------------------------------------
  it('returns not_found error on a bogus app slug', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    const adapter = new FlyDeployAdapter({
      token: env.token!,
      app: 'cert-bogus-app-' + Math.random().toString(36).slice(2),
      image: 'registry.fly.io/cert/never-used:latest',
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
  it('rolls back to the previous Fly release and re-serves its URL', async (t: TestContext) => {
    if (!env.ready) {
      t.skip(env.reason);
      return;
    }
    if (!hasImage) {
      t.skip(imageSkipReason);
      return;
    }
    const adapter = new FlyDeployAdapter({
      token: env.token!,
      app: env.target!,
      image: image!,
      pollIntervalMs: 5000,
      maxPollMs: 8 * 60 * 1000,
    });
    const result = await runCheck(
      async () => {
        // Two consecutive deploys produce two releases. Fly's release
        // counter is server-assigned; the adapter remembers the
        // previous one for `rollback({})`'s implicit target.
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
          // As above — private apps may have no URL. Soft-fail, not
          // adapter bug.
          throw new CertFlakeError('rollback returned no URL (private app?)');
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
    if (!hasImage) {
      t.skip(imageSkipReason);
      return;
    }
    const adapter = new FlyDeployAdapter({
      token: env.token!,
      app: env.target!,
      image: image!,
      pollIntervalMs: 5000,
      maxPollMs: 8 * 60 * 1000,
    });
    // Outer-scope buffer so `writeLogTail` below sees the last attempt's
    // lines; callback RESETS each retry (Bugbot MEDIUM PR #92 — see
    // vercel.cert.ts for the full failure mode).
    let lines: string[] = [];
    const result = await runCheck(
      async () => {
        lines = []; // fresh buffer per attempt
        let releaseId: string | undefined;
        const deployPromise = adapter.deploy({
          // Plant a secret in the deploy meta so the adapter has
          // something to redact in `output`. Fly may or may not echo
          // meta into build logs; the redaction assertion covers both
          // surfaces.
          meta: { CERT_PLANTED_SECRET: 'AKIAIOSFODNN7EXAMPLE' },
          onDeployStart: (id) => {
            releaseId = id;
          },
        });
        const idDeadline = Date.now() + 30 * 1000;
        while (!releaseId && Date.now() < idDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!releaseId) {
          throw new CertFlakeError('release id not surfaced within 30s');
        }
        const ctrl = new AbortController();
        const logTimeout = setTimeout(() => ctrl.abort(), 60 * 1000);
        try {
          for await (const line of adapter.streamLogs({
            deployId: releaseId,
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
