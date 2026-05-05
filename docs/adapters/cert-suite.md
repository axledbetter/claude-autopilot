# Adapter Certification Suite — Operator Runbook

**What this is.** A separate test target, `npm run test:adapters:live`, that exercises the Vercel + Fly + Render deploy adapters against real provider APIs. Phase 7 of the v6 Run State Engine.

**Why it exists.** Mock-only adapter tests caught a HIGH and a MEDIUM during v5.6 (Render service-scoped URL, Render polling cursor sort) — both issues where the spec author got the API shape wrong. Live cert prevents the next "spec was wrong, user finds out at 2 a.m." failure mode from shipping.

**Spec:** [`docs/specs/v6-run-state-engine.md` § "Real adapter certification suite (Phase 7)"](../specs/v6-run-state-engine.md).

---

## TL;DR — what the operator does

1. Create one free-tier sandbox account on each of Vercel, Fly, Render.
2. Pre-create one hello-world project / app / service per provider.
3. Generate a scoped API token on each provider.
4. Add 7 GitHub Secrets to this repo (token + target id per provider; Fly also needs an image ref).
5. The nightly workflow (09:00 UTC) starts running — soft-fails alert, hard-fails block.

Until step 4 is done, every cert test skips cleanly with a friendly "no creds — see runbook" message. Nothing breaks; the suite is built to be safe by default.

---

## How the suite is structured

```
tests/adapters/live/
  _harness.ts          — env-gated skip + retry + soft-fail + artifact paths
  _harness.test.ts     — UNIT tests for the harness (run under regular npm test)
  vercel.cert.ts       — 5 assertions, env-gated
  fly.cert.ts          — 5 assertions, env-gated (also needs FLY_IMAGE_TEST)
  render.cert.ts       — 5 assertions, env-gated
```

Each provider's cert tests assert exactly five things, per spec:

1. **Deploy success** — push the hello-world artifact, get a deploy ID, poll until terminal, assert `status === 'pass'` and the deploy URL responds with HTTP 200.
2. **Auth failure** — pass a deliberately-bad token; expect `GuardrailError(code: 'auth')`.
3. **404 path** — pass a bogus project / app / service id; expect `GuardrailError(code: 'not_found')`.
4. **Rollback** — deploy v1, deploy v2, rollback, assert v1's URL serves again.
5. **Log streaming + redaction** — subscribe to `streamLogs`, assert lines arrive within timeout, assert that a planted `AKIAIOSFODNN7EXAMPLE` secret is redacted in both the streamed lines and the final `result.output`.

---

## How to add the secrets to this repo

GitHub UI → repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add each of the following.

### Vercel

| Secret name | What to set it to |
|---|---|
| `VERCEL_TOKEN_TEST` | Vercel personal access token. Create at [vercel.com/account/tokens](https://vercel.com/account/tokens). Scope: full account or just the cert sandbox project. |
| `VERCEL_PROJECT_TEST` | The project ID (or slug) of a pre-created hello-world project on the cert sandbox account. |

**Sandbox setup:**
1. Sign up for free Hobby plan on [vercel.com](https://vercel.com).
2. Create a new project — connect any git repo, or paste a static `index.html` via `vercel deploy`. The static-page template is fine.
3. Confirm the URL serves HTTP 200 in a browser.
4. Copy the project ID from `Settings → General → Project ID`.

### Fly

| Secret name | What to set it to |
|---|---|
| `FLY_API_TOKEN_TEST` | Fly personal access token. Create at [fly.io/dashboard/personal/tokens](https://fly.io/dashboard/personal/tokens). |
| `FLY_APP_TEST` | The app slug of a pre-created hello-world Fly app on the cert sandbox account. |
| `FLY_IMAGE_TEST` | Fully-qualified pre-pushed image ref, e.g. `registry.fly.io/<app>:cert-hello-world`. |

**Why the image ref:** the Fly adapter does NOT build images itself (per the v5.6 spec — "pushing is the user's responsibility"). The cert suite assumes you pushed a hello-world image once during sandbox setup; nightly runs deploy that same image over and over. This keeps the workflow from needing a Docker build host inside CI.

**Sandbox setup:**
1. Sign up at [fly.io](https://fly.io) and create a free-trial app.
2. From a local machine with `flyctl` installed:
   ```bash
   flyctl apps create <your-cert-app-slug>
   flyctl deploy --app <your-cert-app-slug> --build-only --push --image-label cert-hello-world
   ```
3. Confirm the image was pushed: `flyctl image show --app <your-cert-app-slug>`.
4. Set `FLY_IMAGE_TEST` to `registry.fly.io/<your-cert-app-slug>:cert-hello-world`.

### Render

| Secret name | What to set it to |
|---|---|
| `RENDER_API_KEY_TEST` | Render API key. Create at [dashboard.render.com/u/settings#api-keys](https://dashboard.render.com/u/settings#api-keys). |
| `RENDER_SERVICE_TEST` | Render service ID, e.g. `srv-abc123`. Found in the URL of the service dashboard. |

**Sandbox setup:**
1. Sign up at [render.com](https://render.com).
2. Create a new web service — pick the free instance type and connect any git repo with a `Dockerfile` or static-site config.
3. Wait for the first build to succeed (~5 min on free tier).
4. Copy the service ID from the dashboard URL: `https://dashboard.render.com/web/srv-abc123` → `srv-abc123`.

---

## How to read failures

Every check writes an event to `artifacts/adapter-cert/<provider>/<runId>/events.ndjson`. Outcomes:

| Event | Meaning |
|---|---|
| `check.success` | The check passed. No action needed. |
| `check.skipped` | Env vars missing or partial — the suite hadn't been enabled yet for this provider. Action: add the secrets per the table above. |
| `check.soft-fail` | A flaky check (transient network, log-streaming gap) failed within the retry budget. Logged + uploaded but the workflow exit code stays at 0. Action: investigate if the same check soft-fails on the next nightly. |
| `check.hard-fail` | A deterministic check (auth, 404, schema mismatch) failed, OR a soft-failable check hit 3 consecutive soft-fails and got escalated. Action: open a fix PR; the workflow has turned red. |

**Soft-fail vs hard-fail decision matrix** (from `_harness.ts#classifyError`):

| Error | Category | Behavior |
|---|---|---|
| `GuardrailError(auth)` | deterministic | hard-fail, no retry |
| `GuardrailError(not_found)` | deterministic | hard-fail, no retry |
| `GuardrailError(invalid_config)` | deterministic | hard-fail, no retry |
| `GuardrailError(rate_limit)` | transient | retry up to 3 attempts (1s/4s/16s); soft-fail on exhaustion |
| `GuardrailError(transient_network)` | transient | retry up to 3 attempts; soft-fail on exhaustion |
| `CertFlakeError` (thrown by the cert tests) | flaky | retry up to 3 attempts; soft-fail on exhaustion |
| Anything else (plain `Error`) | unknown | hard-fail immediately, no retry |

After **3 consecutive soft-fails** on the same `(provider, check)` tuple within a single workflow run, the harness escalates the next failure to a hard-fail. Per spec.

## How to read the artifacts

The workflow uploads an `adapter-cert-<run-id>` artifact bundle. Inside:

```
artifacts/adapter-cert/
  vercel/<runId>/
    events.ndjson   — one line per check event
    log-tail.txt    — last 200 lines from the log-streaming check (if any)
  fly/<runId>/
    events.ndjson
    log-tail.txt
  render/<runId>/
    events.ndjson
    log-tail.txt
```

A triage engineer can replay the failure timeline by reading `events.ndjson` chronologically. The `log-tail.txt` file is what the platform's `streamLogs` actually yielded — useful for confirming redaction worked even when the test passed.

---

## How to run locally

```bash
# Skip mode (default — works on any dev machine)
npm run test:adapters:live

# Live mode — set the per-provider env vars first
export VERCEL_TOKEN_TEST=...
export VERCEL_PROJECT_TEST=prj_...
npm run test:adapters:live
```

A subset works too — set only `RENDER_*` env vars and only the Render cert runs live; the others skip.

For a fully isolated artifact path while iterating:

```bash
ADAPTER_CERT_ARTIFACT_DIR=/tmp/cert-iter npm run test:adapters:live
```

---

## How to add a new provider

1. Add the provider id to `ProviderId` in `tests/adapters/live/_harness.ts`.
2. Add an entry to `PROVIDER_TOKEN_ENV` and `PROVIDER_TARGET_ENV`.
3. Create `tests/adapters/live/<provider>.cert.ts` mirroring the Vercel / Fly / Render shape — five assertions, env-gated skip, run through `runCheck`.
4. Add the new file to the `test:adapters:live` script in `package.json`.
5. Add the new secrets to `.github/workflows/adapter-cert.yml`.
6. Document the sandbox setup in this runbook.
