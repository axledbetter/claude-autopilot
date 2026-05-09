# v6 → v7.0 Breaking Changes

This document is the migration checklist for upgrading from any v6.x to
v7.0.0. The goal: be explicit about everything that changed and give
you a single page to scroll through before running `npm install -g
@delegance/claude-autopilot@latest`.

## TL;DR

1. Drop `--no-engine` from your CLI invocations / scripts / CI.
2. Unset `CLAUDE_AUTOPILOT_ENGINE=off` in your env / CI.
3. If your code imports `ENGINE_DEFAULT_V6_0` or `ENGINE_DEFAULT_V6_1`,
   replace with literal `true`.
4. (Hosted product only) Set `MEMBERSHIP_CHECK_COOKIE_SECRET` in your
   Vercel project env. See [docs/v7/runbook.md](./runbook.md).

Everything else is source-compatible.

## CLI

### Removed

#### `--no-engine` flag

The flag is rejected with `invalid_config` exit 1 in v7.0. The engine
is unconditionally on; there is no engine-off code path to opt into.

Before:
```bash
claude-autopilot scan --no-engine src/auth/
```

After:
```bash
claude-autopilot scan src/auth/
```

#### `CLAUDE_AUTOPILOT_ENGINE=off` env var

Setting the env var to `off` / `false` / `0` / `no` produces a one-shot
stderr deprecation warning and emits a `run.warning` event with code
`engine_off_removed` into the durable run log, then runs engine-on
anyway. This is intentionally softer than the `--no-engine` rejection
because env vars in CI are sticky and silently breaking every
v6.x → v7 upgrade in CI on day one would burn user trust.

The env value is fully ignored — you can leave it set during your
upgrade, but please clean it up. The warning will fire on every CLI
invocation until the env var is unset.

### Deprecated (still works as a no-op)

#### `--engine` flag

`--engine` becomes a no-op shim with a one-shot per-process
deprecation warning to stderr. The engine is always on; the flag is
preserved so existing scripts don't break.

```
[deprecation] --engine is a no-op in v7.0+ (engine is always on). Drop the flag from your scripts.
```

You can safely remove the flag from your scripts at your leisure — the
removal will eventually land in v8.

## Library exports

### Removed

#### `ENGINE_DEFAULT_V6_0` / `ENGINE_DEFAULT_V6_1` constants

If your code imports either constant from
`@delegance/claude-autopilot/dist/src/core/run-state/resolve-engine.js`
or its TypeScript source, the import will fail in v7.0.

Before:
```typescript
import { ENGINE_DEFAULT_V6_1 } from '@delegance/claude-autopilot/...';
const enabled = options.engine ?? ENGINE_DEFAULT_V6_1;
```

After:
```typescript
const enabled = options.engine ?? true;
```

#### `runEngineOff` (RunPhaseWithLifecycleOpts)

The `runEngineOff` callback on `runPhaseWithLifecycle` opts is
preserved as an optional property for source compatibility, but the
helper NEVER invokes it in v7.0. New call sites should omit it
entirely.

### Behavior change

#### `resolveEngineEnabled()` always returns `{enabled: true, source: 'default'}`

The function shape is preserved. All inputs (`cliEngine`, `envValue`,
`configEnabled`, `builtInDefault`) are accepted but ignored.

## Run state engine

### Schema version bumped: 1 → 2

`RUN_STATE_SCHEMA_VERSION` is now `2`. Newly-written `state.json` files
declare `schema_version: 2`.

#### Forward read

v7.0 binaries can read v6.x-written runs (`schema_version: 1`) without
issue. `RUN_STATE_MIN_SUPPORTED_SCHEMA_VERSION` stays at `1`.

#### Backward read

v6.x binaries reading v7-written runs hit a `corrupted_state` error
with the message:

```
state was written by a newer Autopilot version (schema_version=2; this
binary supports [1..1]); downgrade resume is not supported.
```

If you need to roll back from v7 to v6, you also need to either delete
`.guardrail-cache/runs/<id>/` for any v7-written runs, OR resume them
from the v7 binary first.

## Hosted product (apps/web)

These changes only affect operators of the autopilot.dev hosted
product. CLI users can ignore this section.

### New env var: `MEMBERSHIP_CHECK_COOKIE_SECRET`

A ≥32-byte secret used to HMAC-sign the `cao_membership_check` cookie
that the dashboard middleware uses to cache membership-status checks
for 60s. Generate with:

```bash
openssl rand -hex 32
```

Set it in your Vercel project env. Validation runs on first use
(lazy/runtime), NOT module-load — `next build` in CI without the
secret won't crash, but the middleware fails closed if the secret is
missing or too short at request time.

### New page: `/access-revoked`

When the dashboard middleware revokes a session because the user's
membership changed to disabled / inactive / no_row, OR because the RPC
check failed, the user is redirected here with `?reason=<code>`. The
page renders one of four messages and a Sign-out button.

This page is NOT in the auth-required surface — it deliberately does
not auto-forward authenticated users (which would loop revoked users
back through `/dashboard` → `/access-revoked` → ...).

### Middleware runtime: `nodejs` (was `edge` by default)

`apps/web/middleware.ts` now exports `runtime = 'nodejs'`. The Phase 6
HMAC + `crypto.timingSafeEqual` implementation requires `node:crypto`,
which isn't available in Vercel's Edge runtime.

Cold-start cost: ~50-100ms vs Edge. This trade-off is documented in
the spec and runbook.

### New SQL migration

`data/deltas/20260509200000_phase6_check_membership_rpc.sql` adds the
`check_membership_status(p_org_id uuid, p_user_id uuid)` function with
`SECURITY INVOKER` (NOT DEFINER), `REVOKE` from PUBLIC/anon/authenticated,
and `GRANT EXECUTE` to service_role only.

Apply via `npm run migrate` or your usual delta-promotion pipeline
before deploying v7.0.

## Runtime versions

No change. v7.0 still requires Node ≥22.0.0.

## CI / publishing

### npm dist-tag policy

Tags matching `v[0-9]+.[0-9]+.[0-9]+` (no suffix) publish with
`--tag latest`; everything else publishes with `--tag next`.

`package.json` `publishConfig.tag` stays at `next` as a hand-publish
fallback only — the workflow is the source of truth.

## v7.0 → v7.1 — ingest-API JWT membership re-check

> Hosted product (`apps/web/`) only. CLI users can ignore this section.

### Summary

v7.1 closes the symmetric gap that v7.0 Phase 6 left open: upload-session
JWTs (15-min TTL) keep working for org-scoped members who get disabled
mid-session. v7.1 adds a per-request membership re-check on every
ingest event-write + finalize, collapsing the JWT-authenticated
revocation window from ≤15min to **≤1 request** for org-scoped runs.

### Behavior change

After deploy, every PUT `/api/runs/:runId/events/:seq` and POST
`/api/runs/:runId/finalize` request runs the
`check_membership_status(p_org_id, p_user_id)` RPC (the same RPC Phase
6 added) BEFORE the chunk write or manifest write. Org-scoped tokens
where the member's status is anything other than `'active'` get a
**403** with `{error: 'member_disabled' | 'member_inactive' |
'no_membership'}`. RPC errors get a **503** `{error:
'member_check_failed'}` (retryable; the CLI uploader's existing
5xx-retry path covers this automatically).

### Rollout

**No coordinated cutover required.** The JWT format change is
forward-only and backward-compatible:

- **In-flight v7.0 org-scoped tokens** (no `mint_status` claim, but
  `org_id` populated) enforce the new revocation check immediately on
  their **next** event-write or finalize after deploy. `claims.org_id`
  is the sole authorization authority — the cosmetic `mint_status`
  claim is only used for observability/audit.
- **In-flight v7.0 personal-run tokens** (`org_id: ''` empty string)
  short-circuit safely via the `!claims.org_id` falsy check. They
  skip the new RPC entirely.
- **v7.1 tokens** mint with the new `mint_status: 'active' | 'personal'`
  claim for log filtering. Authorization behavior is identical to v7.0
  tokens of the same org-scoped/personal shape.

**No 15-min latency window for org-scoped tokens.**

### Mint endpoint change

POST `/api/upload-session` now refuses to mint for non-active org
members:

- `r.organization_id` populated + member status ≠ `'active'` → **403**
  `{error: 'member_not_active'}` + `audit_events` row with
  `action: 'ingest.mint_refused'`. No upload session created.
- `r.organization_id` populated + RPC failure → **503** `{error:
  'member_check_failed'}` (retryable). No upload session created.
- `r.organization_id` IS NULL → no RPC; mint with `mint_status:
  'personal'`.

### No new env vars

The existing JWT secret + 15-min TTL are unchanged. v7.0's
`MEMBERSHIP_CHECK_COOKIE_SECRET` is still only used by the dashboard
middleware, NOT by the ingest re-check. The ingest helper makes a
direct `check_membership_status` RPC call per request (intentional —
chunk requests are sequential per session and the per-request RPC
cost is bounded; see "Capacity" in the spec).

### No new SQL migration

Phase 6's `check_membership_status` RPC is reused verbatim. The
v7.1 PR ships pure TypeScript + a single test-stub change.

## See also

- [docs/v7/runbook.md](./runbook.md) — production deployment guide.
- [CHANGELOG.md](../../CHANGELOG.md) — comprehensive v7.0.0 entry.
