# autopilot.dev — production deployment runbook

This runbook covers operating the `apps/web/` hosted product on
Vercel. The CLI (`@delegance/claude-autopilot`) is shipped via
`npm publish` independently — see `.github/workflows/ci.yml` for that
pipeline.

> **Deployment target reminder:** `apps/web/` deploys to **Vercel**.
> This is NOT the same codebase as `delegance-app` (which deploys to
> AWS ECS). If you're reading guidance from a cross-repo CLAUDE.md,
> the ECS / Docker / BullMQ details there do not apply.

## First-deploy checklist

1. [Vercel env vars](#vercel-env-vars) — set every group below in your
   Vercel project's environment variables.
2. [Supabase](#supabase) — apply migrations through
   `data/deltas/`, including `20260509200000_phase6_check_membership_rpc.sql`.
3. [WorkOS](#workos) — configure SSO connections + webhook + admin
   portal redirect.
4. [Stripe](#stripe) — create products / prices, set up webhook.
5. [Cron](#cron) — verify `vercel.json` cron schedule is wired and
   `CRON_SECRET` is set.
6. Trigger a test deploy from the `master` branch. Verify
   `/api/health/deep` returns 200.
7. Smoke-test the dashboard end-to-end: `dashboard login` from CLI →
   browser callback → API key minted → dashboard nav loads.

## Vercel env vars

All env vars are documented in `apps/web/.env.example`. Group them by
purpose:

### Supabase
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_PROJECT_REF`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; never expose to client.

### Public URLs
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_AUTOPILOT_BASE_URL`
- `AUTOPILOT_PUBLIC_BASE_URL`

### Stripe
- `STRIPE_SECRET_KEY` — `sk_test_...` in dev, `sk_live_...` in prod.
- `STRIPE_WEBHOOK_SECRET` — copied from the Stripe webhook config.
- `STRIPE_PRICE_SMALL_MONTHLY` / `_YEARLY`
- `STRIPE_PRICE_MID_MONTHLY` / `_YEARLY`

### WorkOS
- `WORKOS_API_KEY`
- `WORKOS_WEBHOOK_SECRET`
- `WORKOS_CLIENT_ID`

### Phase 2.2 ingest API
- `UPLOAD_SESSION_JWT_SECRET` — generate with `openssl rand -hex 32`.

### Phase 5.6 SSO
- `SSO_STATE_SIGNING_SECRET` — ≥32-byte secret. Generate with
  `openssl rand -hex 32`.

### Phase 5.8 cron
- `CRON_SECRET` — Vercel auto-injects on production cron deployments;
  override with any non-empty string for local dev.

### Phase 6 (new in v7.0)
- `MEMBERSHIP_CHECK_COOKIE_SECRET` — ≥32-byte secret used to HMAC-sign
  the dashboard's middleware membership-cache cookie. Generate with
  `openssl rand -hex 32`. **Required for dashboard middleware to
  function.** Validation is lazy/runtime: `next build` won't crash
  without it, but the middleware will fail closed on every request
  until the secret is set.

  **Rotation (v7.1.1+):** dual-secret rotation is supported via the
  optional `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS` env var. Verify
  tries CURRENT first; on signature mismatch, tries PREVIOUS. New
  cookies always sign with CURRENT. Operator flow:

  1. `NEW=$(openssl rand -hex 32)`
  2. Set `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS` = current value.
  3. Set `MEMBERSHIP_CHECK_COOKIE_SECRET` = `$NEW`.
  4. Deploy.
  5. Wait ≥60s (one cookie TTL — every cached cookie has now been
     re-signed with `$NEW`).
  6. Unset `MEMBERSHIP_CHECK_COOKIE_SECRET_PREVIOUS` at the next deploy.

  Without `_PREVIOUS` (v7.0/v7.1.0 behavior), rotating `CURRENT`
  invalidates every outstanding cookie at once = thundering herd of
  `check_membership_status` RPC calls. Always set `_PREVIOUS` when
  rotating.

## Supabase

### Migration

Apply all `data/deltas/` SQL files to your Supabase Postgres in
chronological order. The Delegance `/migrate` skill or your CI
migration job handles the ledger. The Phase 6 delta to apply for v7.0:

```
data/deltas/20260509200000_phase6_check_membership_rpc.sql
```

This adds the `check_membership_status(p_org_id uuid, p_user_id uuid)`
RPC that the dashboard middleware calls on cache miss. The function is
`SECURITY INVOKER`, REVOKE'd from PUBLIC/anon/authenticated, and only
GRANTed to `service_role`.

**Critical: apply this migration BEFORE deploying the v7.0 web image**
(codex PR-pass WARNING #1). The middleware fails closed if the RPC is
missing — every dashboard request that misses the 60s cache cookie
will return `check_failed` and route the user to `/access-revoked`.
Recommended deploy order:

1. Apply `20260509200000_phase6_check_membership_rpc.sql` to prod.
2. Verify with `SELECT check_membership_status(<any-org-uuid>, <any-user-uuid>);`
   from the Supabase service role (should return JSON with
   `status='no_row'` for an arbitrary pair).
3. Deploy v7.0 web image to Vercel (or promote v7.0 build).
4. Smoke-test `/dashboard` page-load + one `/api/dashboard/*` call.

Rollback (RPC unavailable post-deploy): revert the web deploy. The
RPC migration is forward-only and safe to leave in place — pre-Phase-6
web images don't call the RPC.

### RLS

All membership / org tables have RLS enabled. The middleware reaches
them only via the `service_role` key + the new RPC, so no RLS policy
changes are needed for v7.0.

## WorkOS

### Admin portal redirect

Set the redirect to `https://autopilot.dev/api/workos/admin-portal-callback`.

### Webhook URL

Set to `https://autopilot.dev/api/workos/webhook`. Sign with
`WORKOS_WEBHOOK_SECRET`.

### SSO

Per-tenant SSO connections are managed via the WorkOS dashboard. The
admin portal flow in `/dashboard/admin/sso` lets your customers set up
their own connection without you touching the dashboard.

## Stripe

### Products / prices

Create one product per tier, with monthly + yearly prices each. Copy
the price IDs into the four `STRIPE_PRICE_*` env vars.

### Webhook

Set the webhook URL to `https://autopilot.dev/api/stripe/webhook`. Set
the signing secret to `STRIPE_WEBHOOK_SECRET`.

Subscribe to: `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_succeeded`, `invoice.payment_failed`.

## Cron

`vercel.json` declares one cron job (Phase 5.8 — expired SSO state
cleanup). Verify Vercel auto-injects `CRON_SECRET` for cron-attached
deployments.

To rotate `CRON_SECRET`: edit the env in Vercel project settings,
trigger a new deploy. Old cron requests with the previous secret will
401 until the new deploy is live; that's expected.

## Membership revocation cache (Phase 6)

The dashboard middleware caches membership-status checks for 60s in
the HMAC-signed `cao_membership_check` cookie. This bounds the
worst-case revocation window (admin disables a user → user can no
longer access the dashboard) to ≤60s, down from the v6 worst case of
≤1h (= access-token expiry).

To tighten the window further, you'd need to either:
1. Reduce the cookie TTL (currently hard-coded at 60s; v7.1 will
   expose `MEMBERSHIP_CHECK_TTL_SECONDS` env var).
2. Add server-side cache-invalidation on `change_member_role` /
   `disable_member` RPCs (deferred to v7.1).

## Operational steps the agent does NOT do

These are listed here so the human operator has a single checklist;
none of them land in the v7.0 PR:

- Privacy doc, landing page, pricing page (marketing copy).
- Domain registration, DNS configuration.
- Stripe **live** keys (test keys are wired today; switching to live
  keys is an operational step in the Stripe dashboard + Vercel env).
- Monitoring/alerting configuration (Sentry, Vercel observability,
  Supabase alerts).
- npm `latest` tag publish — CI publishes on tag push (`git tag
  v7.0.0 && git push --tags`); the workflow flips `latest` for plain
  semver tags automatically.

## See also

- [docs/v7/breaking-changes.md](./breaking-changes.md) — v6 → v7
  migration checklist.
- [CHANGELOG.md](../../CHANGELOG.md) — full v7.0.0 release notes.
- [apps/web/.env.example](../../apps/web/.env.example) — canonical env var list.
