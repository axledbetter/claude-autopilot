# Strategic pivot — codex review of project state, 2026-05-11

> **Audience:** future-me + anyone trying to understand why v7.5+
> doesn't immediately ramp into v8 daemon implementation.
>
> **TL;DR:** Codex 5.5 reviewed the full project state on 2026-05-11
> and concluded: "shipping v8 daemon" is the wrong next milestone.
> The strongest validated asset is the existing CLI chat-session
> loop. The hosted product MVP is feature-complete but unused.
> Before building v8, validate demand for unattended autonomy.
>
> Full review log: `/tmp/codex-state-review.log` (operator-local;
> not in repo).

## Context

After 22 PRs shipped this session (#135 → #156, v7.0 Phase 5.7
through v7.4.0), the natural next move felt like "start
implementing the v8 standalone daemon." The merged v8 spec
(`docs/specs/v8.0-standalone-daemon.md`) is locked, the v7.3.0
library export surface is the explicit prerequisite, and v7.4.0's
Python/FastAPI support gates v8's stabilization criterion #2 (4-repo
benchmark suite).

Asked codex 5.5 for a strategic review before committing to the
v8 implementation push. Five questions; got 9 actionable findings
back.

## Findings (codex 5.5 review)

### CRITICAL findings

**C1 — v8 daemon cannot ship before sandbox + credential isolation
exist.** Already the v8 spec position; codex confirms ordering:
policy loader/pinner → sandbox harness → credential mount denial
tests → egress allowlist tests → GitHub auth boundary → SQLite
state machine. Do NOT implement hosted workers, auto-merge, or
billing until sandbox-escape and idempotency suites pass.

**C2 — Vercel-vs-ECS deployment confusion.** **REJECTED — false
positive.** This is the 7th time codex has confused autopilot.dev
(which IS Vercel-deployed) with delegance-app (an unrelated ECS
codebase). Documented in the v8 spec already; will continue to
guard with explicit deployment-target headers in future docs.

### WARNING findings (all accepted)

**W1 — v8 is concrete eng but unvalidated product bet.** The
biggest finding. Validate demand for unattended autonomy via
10-20 design-partner conversations + thin hosted beta/waitlist
BEFORE committing to v8 implementation. The CLI chat-session
loop is the validated asset; v8 is an unvalidated bet.

**W2 — Hosted beta readiness is operational, not feature-completion.**
A feature-complete unused control plane is riskier than a
smaller-deployed beta. Need: landing page, pricing/waitlist,
privacy/terms, one CLI-to-hosted onboarding flow, Stripe
test-to-live verification, WorkOS gated until manually approved,
production logging/alerts, webhook replay procedure, one internal
dogfood org with real billing/test billing.

**W3 — Hosted product value-prop not yet distinct from CLI.**
Pick ONE primary hosted use case for beta. Three candidates:
(a) "team-visible audit trail for autonomous Claude Code runs,"
(b) "centralized cost/risk governance,"
(c) "hosted unattended workers."
Then cut or hide features that don't support the chosen one.

**W4 — Org-tier revocation gap.** Server-side cache invalidation
on `change_member_role` / `disable_member` is deferred. Gates the
org-tier sales conversation. Schedule before broadly beta-testing
org tier; if keeping the ≤60s window temporarily, document
clearly in admin UI + security notes.

**W5 — v8 should be local-only alpha first.** Confirms my
instinct. v8.0-alpha = policy file + GitHub fine-grained PAT +
SQLite state machine + sandboxed phases. NO hosted workers, NO
billing, NO auto-merge. Use the alpha to validate demand before
any hosted work.

### NOTE findings (all accepted)

**N1 — Bounded benchmark suite (4 repo shapes), not every
feature.** Already in the v8 spec stabilization criterion #2:
blank Node/TS, Python/FastAPI, existing mature app, messy legacy
repo. Run pre-release + after major workflow changes, NOT after
every patch.

**N2 — Risk-tiered codex passes.** Clean rule, no per-spec
judgment needed:

| Spec risk | # of codex passes |
|---|---|
| Low-risk CLI UX changes (e.g. v7.1.7 setup polish) | 1 |
| New execution modes / auth / billing / data-access changes | 2 |
| Sandboxing / multi-tenancy / auto-merge / repo-mutation | 3 + external review |

The v8 spec pass-2 finding 3 CRITICALs (esp. C3 sandbox/credential
exfiltration) is concrete evidence that 1 pass is insufficient
for security-sensitive architecture.

**N3 — Missing senior-eng artifacts: production operations + customer
discovery.** The biggest gap by category. Pre-beta needs:
- Observability dashboard
- Alert destinations
- Webhook replay docs
- Database backup/restore drill
- Audit-log verification procedure
- Data deletion path
- Support inbox
- Customer interview script
- Success metrics for first 5-10 beta users

## Decisions locked from this review

### What we are NOT doing next

- ❌ **Implementing v8 daemon.** The spec is good; the implementation
  push is premature without validated demand.
- ❌ **Adding more CLI verbs / scaffold extensions / etc.** v7.4.0
  closes the "n=1 stack benchmark" caveat; v7.5 (Go/Rust scaffold)
  is genuinely deferrable.
- ❌ **Building hosted-product features** beyond what's already
  shipped in apps/web/.

### What we ARE doing next (in priority order)

1. **Customer discovery sprint.** 10-20 design-partner conversations
   asking "would you want autonomous repo watching outside a Claude
   Code chat session, and if so, what would you pay for it?" No
   autopilot work here — just calls + a pitch deck draft.

2. **Hosted beta readiness slice (operational, not feature work).**
   Per W2: landing page, pricing/waitlist, privacy/terms, ONE CLI-to-
   hosted onboarding flow, Stripe test-to-live verification, prod
   logging/alerts, webhook replay docs, internal dogfood org. NOT
   "unhide the dashboard for everyone" — a deliberately narrow
   slice gated to the W3 use-case pick.

3. **Org-tier revocation completion (W4).** Implement server-side
   cache invalidation on `change_member_role` + `disable_member`.
   Closes a security/compliance conversation that gates org-tier
   sales. ~4-6hr ship; can land in v7.4.x.

4. **Risk-tiered codex policy (N2) baked into the autopilot skill.**
   Update `.claude/skills/autopilot/SKILL.md` to declare the 1/2/3-
   pass tiers explicitly. Future spec PRs cite which tier they're
   on. ~30min ship.

### What v8 looks like IF customer discovery validates demand

Per W5, v8.0-alpha is local-only:
- `.autopilot/policy.yaml` (required, pinned at run-start SHA)
- GitHub fine-grained PAT (NOT `gh` CLI auth)
- SQLite per-repo state machine + signed audit log
- Per-phase Docker/Podman sandbox, credential mounts blocked
- Egress allowlist (GitHub + Anthropic + OpenAI + npm/pypi/cargo)
- NO hosted workers, NO billing, NO auto-merge, NO web dashboard

If alpha validates demand, v8.0-beta adds hosted tier per the spec.
If alpha shows no demand, the v7.x chat-session product is the
real product and we double down there.

## Process changes adopted from this review

- **Risk-tiered codex passes** (N2). Codified in the autopilot skill
  in v7.4.x. Per-spec `risk: low|medium|high` field will determine
  pass count.
- **Strategic codex review every ~10 PRs.** This review caught the
  "ship more without validating demand" trap. Recurring strategic-
  state passes (separate from per-spec passes) prevent the trap
  from forming again.
- **Bounded benchmark suite gate** (N1). v8 spec already requires
  4-repo benchmark; v7.4.0 closed Python/FastAPI; v7.5 will close
  Go/Rust if and only if a customer asks.

## Note on the Vercel-vs-ECS false positive

7th time codex has flagged `apps/web/` as "should be rewritten for
ECS." Each time the answer is the same: autopilot.dev IS the Vercel-
deployed product; the delegance-app codebase is a separate ECS
deployment that codex's training data conflates because both projects
have similar structure.

Future spec docs touching apps/web/ should include an explicit
deployment-target header (already done in v7.0 Phase 6 + v7.1 specs).
Cross-codebase confusion is a known limitation of the current codex
review setup, not a code defect.

## What this doc is NOT

- Not a v8 implementation plan. v8 is on hold pending customer
  discovery.
- Not a marketing strategy. The hosted beta readiness work needs
  its own track + a real PM/founder voice, not autonomous scope.
- Not a final answer. If customer discovery surfaces a different
  shape ("we want a slack-bot, not a daemon"), pivot accordingly.
