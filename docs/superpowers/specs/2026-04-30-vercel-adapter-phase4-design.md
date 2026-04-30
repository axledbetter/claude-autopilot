# v5.4 Vercel adapter — Phase 4 design (auto-rollback)

**Status:** approved spec, ready for plan
**Tracks:** Phases 1–3 already on master (PRs #59, #61, #63 — HEAD `72e8853`)
**Parent spec:** `docs/specs/v5.4-vercel-adapter.md`
**Estimated effort:** ~1h (per parent spec)

---

## What Phase 4 ships

Auto-rollback wired into `runDeploy` orchestration: when a deploy succeeds, the adapter's reported `deployUrl` (or `healthCheckUrl` from config) fails its health check, AND `rollbackOn` includes `'healthCheckFailure'`, the CLI automatically promotes the previous prod deploy and surfaces the rollback distinctly in CLI output and (when `--pr` is set) the PR comment.

This is the **closing of the deploy loop**: deploy → check → fail → rollback, with no human in the loop.

## Surface delta — what was already there vs. what Phase 4 adds

| Surface | Pre-Phase-4 state | Phase 4 change |
|---|---|---|
| `DeployConfig.rollbackOn` field | Already typed (`Array<'healthCheckFailure' \| 'smokeTestFailure'>`) and validated by JSON schema | Reused as-is |
| `DeployResult.rolledBackTo` | Already typed | Newly populated by orchestration on auto-rollback |
| `adapter.rollback()` | Vercel adapter implements it (Phase 3); generic adapter omits | Called by orchestrator on health-check failure |
| `runDeploy()` health check | **Not currently performed** — spec gap | New: invoke `healthCheckUrl` after a `pass` deploy result |
| `runDeploy()` auto-rollback | Not implemented | New: when health check fails AND adapter supports `rollback`, invoke it |
| CLI output | Prints deploy status only | New: distinct `🔄 Auto-rolled back to <id>` line when rollback fired |
| `claude-autopilot deploy --pr <n>` | Not wired | New: post upserting deploy summary comment on PR; comment shows failed deploy URL + rolled-back current URL when applicable |

## Health-check semantics

- Trigger: post-deploy when `result.status === 'pass'` and either `config.healthCheckUrl` is set or the adapter returned a `deployUrl`. Prefer explicit `healthCheckUrl` from config when both exist.
- Method: `GET <url>` with a 30s total timeout. 2xx → pass; anything else → fail.
- Retries: 3 attempts with 2s backoff between (a deploy can take a few seconds for traffic to converge). All three must fail to count as `healthCheckFailure`.
- The health check itself is **not** an adapter concern — it lives in `runDeploy`. Phase 4 keeps the adapter contract surface unchanged.

## Auto-rollback trigger logic

```
if deployResult.status === 'pass'
   AND healthCheckUrl resolves
   AND healthCheck fails 3x
   AND config.rollbackOn includes 'healthCheckFailure'
   AND adapter.rollback is defined:

  prevResult = adapter.rollback({})       // no `to` → adapter finds previous prod
  if prevResult.status === 'pass':
    finalResult = {
      ...deployResult,
      status: 'fail',                     // the deploy as a whole failed
      rolledBackTo: prevResult.deployId,
      output: <distinct rollback message>,
    }
  else:
    // rollback itself failed — fail loud, do not pretend success
    finalResult = {
      ...deployResult,
      status: 'fail',
      output: 'Deploy passed; health check failed; auto-rollback ALSO failed: ' + prevResult.output,
    }
```

**Edge case — no previous deploy:** the adapter's `rollback()` already throws when no rollback target exists (Phase 3 contract). Surface the error verbatim with a clear `[deploy] auto-rollback could not find a previous deploy to promote` prefix. Do not swallow.

**Edge case — adapter does not support rollback (e.g. generic):** log a one-line warning that `rollbackOn` is configured but adapter `<name>` does not support rollback; mark deploy as `fail` due to health check; exit 1. Don't crash.

**Negative case — `rollbackOn` empty / does not include `healthCheckFailure`:** mark deploy as `fail` due to health check, exit 1, no rollback attempted.

## CLI output

On successful auto-rollback, after the regular `[deploy] status=fail …` line, print:

```
🔄 [deploy] auto-rolled-back-to=<prev-id> via=<adapter> health-check-url=<url>
   reason: health check failed 3x against <url>
   current: https://<prev-deployUrl>
```

On rollback failure (no previous deploy / API error), print:

```
🔄 [deploy] auto-rollback FAILED — original deploy left in place
   reason: <error message>
```

Color: yellow (`\x1b[33m`) for the auto-rollback marker — distinguishes from green pass / red fail.

## PR comment update (`--pr <n>`)

`runDeploy` accepts a new `pr?: number` option. When set and `gh` CLI is authenticated, post (or update via marker `<!-- claude-autopilot-deploy -->`) a comment shaped like:

```markdown
<!-- claude-autopilot-deploy -->
## ❌ Deploy auto-rolled back

| Step | Status | URL |
|---|:---:|---|
| New deploy `<dpl_xxx>` | ✅ built | https://… |
| Health check | ❌ failed | <healthCheckUrl> |
| Auto-rollback to `<dpl_yyy>` | ✅ promoted | https://… (current) |

*adapter=vercel · duration=<n>s · @claude-autopilot v<ver>*
```

Plain pass / plain fail (no rollback) variants reuse existing fields and only show the relevant rows. The marker is distinct from the existing `<!-- guardrail-review -->` review comment so they don't collide.

## Test surface

New unit tests in `src/cli/deploy.test.ts` (or co-located `deploy-rollback.test.ts`):

1. **Positive (happy auto-rollback):** stub adapter that resolves `deploy()` → `{status:'pass', deployId:'dpl_new'}`, stub `fetch` that returns 503 to health URL. `rollbackOn: ['healthCheckFailure']`. Assert `adapter.rollback` was called once, result has `rolledBackTo: 'dpl_prev'`, exit code 1, CLI output contains "auto-rolled-back-to=".
2. **Negative — `rollbackOn` empty:** same setup but `rollbackOn: []`. Assert `adapter.rollback` was NOT called, exit code 1.
3. **Negative — `rollbackOn` configured but missing `healthCheckFailure`:** `rollbackOn: ['smokeTestFailure']` only. Assert no rollback attempted.
4. **Edge — no previous deploy:** adapter `rollback()` throws `GuardrailError({code: 'no_rollback_target'})`. Assert exit code 1 and clear error message — no swallowing.
5. **Edge — adapter does not support rollback:** generic adapter (no `rollback` method) + `rollbackOn: ['healthCheckFailure']`. Assert one-line warning, exit code 1, no crash.
6. **Health check passes:** stub fetch returns 200. Assert no rollback, deploy result unchanged, exit code 0.
7. **Health check retries:** stub fetch returns 503 once then 200. Assert no rollback (transient blip recovered).
8. **PR comment with auto-rollback:** `pr: 42` set, mock `gh` shell. Assert comment body contains both deploy URLs and "Auto-rollback" header.
9. **PR comment without auto-rollback:** `pr: 42` set, deploy passes cleanly. Assert simpler success comment.

Existing 904 tests on master must remain green.

## Out of scope (Phase 5/6)

- `smokeTestFailure` trigger wiring — schema accepts it (already does), but Phase 4 does not integrate it with the validate phase. Listed in JSDoc as "Phase 5+".
- Persistent deploy ID cache — Phase 3's "always query Vercel API" decision sticks.
- `claude-autopilot deploy rollback` already exists from Phase 3 — Phase 4 only adds the *auto* path inside `runDeploy`.

## Files touched (estimated)

| File | Change | LOC delta |
|---|---|---|
| `src/cli/deploy.ts` | Health check + auto-rollback orchestration + `--pr` post | +160 |
| `src/cli/index.ts` | `--pr` flag wiring for `deploy` subcommand | +5 |
| `src/cli/deploy-rollback.test.ts` (new) | 9 unit tests above | +400 |
| `docs/specs/v5.4-vercel-adapter.md` | Mark Phase 4 as done | +1 line |

No new files in `src/adapters/`. Phase 4 is pure orchestration glue — the adapter contract is already complete from Phases 1–3.
