# Vercel Deploy Adapter — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the v5.4 Vercel deploy adapter — `DeployAdapter` interface, `vercel` and `generic` adapters, config schema additions, and a `claude-autopilot deploy` CLI subcommand. Phase 2 (log streaming) and Phase 3 (rollback) are deferred.

**Source spec:** `docs/specs/v5.4-vercel-adapter.md`

**Tech Stack:** TypeScript (existing), `node:test` test runner, native `fetch` (Node ≥22), `node:child_process` for the generic adapter, AJV (existing) for config schema.

**Target version:** `5.4.0` (do NOT bump package.json — release tagging is gated on a separate manual step due to paused GitHub Actions billing).

**Important context discovered during planning:**
- The spec references "v5.3 generic `runDeployPhase`" but no such function exists in the current codebase. The generic adapter will be implemented from scratch as a thin wrapper over `child_process.spawn` (the same shape `runDeployPhase` would have had).
- The existing CLI uses `commander`-free hand-rolled subcommand routing in `src/cli/index.ts`. Match that pattern.
- `GuardrailError` already supports `code: 'auth'` — use it for missing/invalid `VERCEL_TOKEN`.
- Tests use `node:test` (`describe` / `it` from `node:test`, `assert` from `node:assert/strict`). NO Jest. Mock `fetch` by stubbing `globalThis.fetch`.

---

## File Structure

### New files (5 source + 4 test)

**Source:**
- `src/adapters/deploy/types.ts` — `DeployAdapter` interface + I/O types
- `src/adapters/deploy/vercel.ts` — Vercel REST API adapter (deploy + status)
- `src/adapters/deploy/generic.ts` — Shell-command adapter (forward-compat for v5.3)
- `src/adapters/deploy/index.ts` — Barrel + factory: `createDeployAdapter(name, options)`
- `src/cli/deploy.ts` — CLI handler: `runDeploy()`

**Tests:**
- `tests/deploy-types.test.ts` — Type-shape sanity (1 test, ensures interface exports)
- `tests/deploy-vercel.test.ts` — Vercel adapter against mocked `fetch` (≥8 tests)
- `tests/deploy-generic.test.ts` — Generic adapter via mocked `child_process.spawn` (2 tests)
- `tests/deploy-config-schema.test.ts` — Config schema accepts/rejects `deploy` block (3 tests)

### Modified files (3)

- `src/core/config/types.ts` — Add `deploy?: DeployConfig` to `GuardrailConfig`
- `src/core/config/schema.ts` — Add `deploy` JSON Schema property
- `src/cli/index.ts` — Wire `deploy` subcommand into the dispatcher + add to `SUBCOMMANDS` and `printUsage()`

---

## Task 1: DeployAdapter interface + types

**File:** `src/adapters/deploy/types.ts`

- [ ] Define `DeployAdapter` interface with `name`, `deploy(input)`, optional `status(input)`, optional `rollback(input)` per spec
- [ ] Define `DeployInput`: `{ ref?: string; commitSha?: string; meta?: Record<string,string>; signal?: AbortSignal }`
- [ ] Define `DeployResult`: `{ status: 'pass'|'fail'|'in-progress'; deployId?: string; deployUrl?: string; buildLogsUrl?: string; durationMs: number; output?: string; rolledBackTo?: string }`
- [ ] Define `DeployStatusInput`: `{ deployId: string; signal?: AbortSignal }`
- [ ] Define `DeployStatusResult` (same shape as `DeployResult` for Phase 1 simplicity, with required `deployId`)
- [ ] Export a `DeployConfig` interface: `{ adapter: 'vercel'|'generic'; project?: string; team?: string; target?: 'production'|'preview'; watchBuildLogs?: boolean; rollbackOn?: Array<'healthCheckFailure'|'smokeTestFailure'>; deployCommand?: string; healthCheckUrl?: string }`
- [ ] Add JSDoc on every exported type explaining its purpose and which adapters use which fields

**Acceptance:**
- File compiles under `tsc -p tsconfig.build.json --noEmit` (no new errors)
- All types exported from `src/adapters/deploy/types.ts`

---

## Task 2: Vercel adapter — deploy()

**File:** `src/adapters/deploy/vercel.ts`

- [ ] Implement `class VercelDeployAdapter implements DeployAdapter`
- [ ] Constructor takes `{ token?: string; project: string; team?: string; target?: 'production'|'preview'; pollIntervalMs?: number; maxPollMs?: number; fetchImpl?: typeof fetch }` (fetch injection for testability)
- [ ] `name = 'vercel'`
- [ ] `deploy(input)`:
  - Resolve token from constructor option → `process.env.VERCEL_TOKEN`. If missing, throw `GuardrailError('Vercel token not set...', { code: 'auth', provider: 'vercel' })`
  - POST `https://api.vercel.com/v13/deployments?teamId=<team>` (omit query if no team) with body `{ name: project, target: target ?? 'production', gitSource: input.commitSha ? { type: 'github', ref: input.commitSha } : undefined, meta: input.meta }`
    - Note: For Phase 1 we don't fully reproduce Vercel's git-source contract (which needs `repoId`/`org`); we just send the minimal viable shape and document that `commitSha`-based deploys may require additional config. Tests cover the request-shape contract only — no live API.
  - On 401/403 → `GuardrailError({ code: 'auth' })` with project name in message
  - On 404 → `GuardrailError({ code: 'invalid_config' })` "project not found"
  - On 5xx or network error → retry with exponential backoff (3 attempts, base 500ms, max 4s)
  - On 200 with `{ id, url }` → kick off polling via `pollUntilTerminal(id)`
- [ ] `pollUntilTerminal(deployId)` (private):
  - GET `https://api.vercel.com/v13/deployments/<deployId>?teamId=<team>` every `pollIntervalMs` (default 2000ms)
  - Bail after `maxPollMs` (default 15 min) → return `{ status: 'in-progress', deployId, durationMs }`
  - Map response `state` → `READY → 'pass'`, `ERROR|CANCELED → 'fail'`, anything else → continue polling
  - Populate `deployUrl` (https://`url`), `buildLogsUrl` (`https://vercel.com/<team-or-user>/<project>/<deployId>`), `durationMs` (now - start)
- [ ] Network retry helper: `fetchWithRetry(url, init, attempts=3, baseMs=500)` — only retries on transient errors (network, 5xx); auth/404 fail fast
- [ ] `status(input)`:
  - GET `https://api.vercel.com/v13/deployments/<input.deployId>?teamId=<team>`
  - Return same shape as `pollUntilTerminal` but single-shot (no polling)
- [ ] All HTTP calls use the injected `fetchImpl ?? globalThis.fetch`

**Acceptance:**
- All API calls go through `fetchImpl` (no direct global `fetch` references)
- All error paths throw `GuardrailError` with appropriate `code`
- File compiles cleanly

---

## Task 3: Generic adapter

**File:** `src/adapters/deploy/generic.ts`

- [ ] Implement `class GenericDeployAdapter implements DeployAdapter`
- [ ] Constructor takes `{ deployCommand: string; healthCheckUrl?: string; spawnImpl?: typeof spawn }` (spawn injection for testability)
- [ ] `name = 'generic'`
- [ ] `deploy()`:
  - Throw `GuardrailError({ code: 'invalid_config' })` if `deployCommand` is empty
  - Spawn the command via `spawn(cmd, args, { shell: true })` (matches v5.3 design where the user provides a free-form command string)
  - Capture stdout to a string buffer, also tee to `process.stderr` for live visibility (skip teeing in tests via env var `AUTOPILOT_DEPLOY_QUIET=1`)
  - On exit code 0 → extract first `https?://` from stdout as `deployUrl`, return `{ status: 'pass', deployUrl, durationMs, output: <last 500 chars> }`
  - On non-zero exit → return `{ status: 'fail', durationMs, output: <last 500 chars> }`
- [ ] No `status()` or `rollback()` (they're optional in the interface)

**Acceptance:**
- Compiles cleanly; spawn injection works for test isolation

---

## Task 4: Adapter factory + barrel

**File:** `src/adapters/deploy/index.ts`

- [ ] Export `*` from `./types`, `./vercel`, `./generic`
- [ ] Export `createDeployAdapter(config: DeployConfig): DeployAdapter`:
  - `if (config.adapter === 'vercel')` → return `new VercelDeployAdapter({ project: config.project!, team: config.team, target: config.target })`
  - `if (config.adapter === 'generic')` → return `new GenericDeployAdapter({ deployCommand: config.deployCommand!, healthCheckUrl: config.healthCheckUrl })`
  - Otherwise throw `GuardrailError({ code: 'invalid_config' })` "unknown deploy adapter"
- [ ] Validate required-by-adapter fields (vercel needs `project`, generic needs `deployCommand`) — throw `GuardrailError({ code: 'invalid_config' })` if missing

**Acceptance:**
- Factory dispatches correctly; missing required fields produce a clear error

---

## Task 5: Config types + schema

**Files:** `src/core/config/types.ts`, `src/core/config/schema.ts`

- [ ] Add `deploy?: DeployConfig` to `GuardrailConfig` interface (import `DeployConfig` from `../../adapters/deploy/types.ts`)
- [ ] Add `deploy` JSON Schema to `GUARDRAIL_CONFIG_SCHEMA.properties`:
  ```json
  {
    "type": "object",
    "required": ["adapter"],
    "additionalProperties": false,
    "properties": {
      "adapter": { "enum": ["vercel", "generic"] },
      "project": { "type": "string" },
      "team": { "type": "string" },
      "target": { "enum": ["production", "preview"] },
      "watchBuildLogs": { "type": "boolean" },
      "rollbackOn": {
        "type": "array",
        "items": { "enum": ["healthCheckFailure", "smokeTestFailure"] }
      },
      "deployCommand": { "type": "string" },
      "healthCheckUrl": { "type": "string" }
    }
  }
  ```
- [ ] Run `loadConfig` smoke test (config-schema.test.ts already loads minimal config — verify nothing breaks)

**Acceptance:**
- Existing `tests/config-schema.test.ts` still passes
- New schema rejects invalid `adapter` values + accepts valid ones (covered by Task 8)

---

## Task 6: CLI deploy subcommand

**File:** `src/cli/deploy.ts`

- [ ] Export `async function runDeploy(opts: { configPath?: string; adapterOverride?: 'vercel'|'generic'; ref?: string; commitSha?: string }): Promise<number>`
- [ ] Load config via `loadConfig(opts.configPath)`
- [ ] Determine adapter:
  - If `opts.adapterOverride` set → use it (with merged config defaults)
  - Else if `config.deploy?.adapter` set → use it
  - Else → exit code 1 with message: "no deploy adapter configured — set `deploy.adapter` in guardrail.config.yaml or pass --adapter"
- [ ] Build adapter via `createDeployAdapter(merged)`
- [ ] Call `adapter.deploy({ ref: opts.ref, commitSha: opts.commitSha })`
- [ ] Print result as a colorized line: `[deploy] status=pass deployId=dpl_xxx url=https://... duration=12.3s`
- [ ] Return exit code: `0` for `pass`, `1` for `fail`, `2` for `in-progress` (timed out polling)

**Acceptance:**
- Compiles cleanly; can be called from `index.ts`

---

## Task 7: Wire CLI into index.ts

**File:** `src/cli/index.ts`

- [ ] Add `import { runDeploy } from './deploy.ts';` at top
- [ ] Add `'deploy'` to the `SUBCOMMANDS` constant array
- [ ] Add a `case 'deploy':` block:
  ```ts
  case 'deploy': {
    const config = flag('config');
    const adapterArg = flag('adapter');
    if (adapterArg && !['vercel', 'generic'].includes(adapterArg)) {
      console.error(`\x1b[31m[claude-autopilot] --adapter must be "vercel" or "generic"\x1b[0m`);
      process.exit(1);
    }
    const ref = flag('ref');
    const commitSha = flag('sha');
    const code = await runDeploy({
      configPath: config,
      adapterOverride: adapterArg as 'vercel'|'generic'|undefined,
      ref,
      commitSha,
    });
    process.exit(code);
    break;
  }
  ```
- [ ] Add `'adapter'`, `'ref'`, `'sha'` to the `VALUE_FLAGS` array
- [ ] Add a `deploy` line to `printUsage()` Commands list and an "Options (deploy):" section

**Acceptance:**
- `claude-autopilot deploy --help` doesn't crash (it falls through to printUsage)
- `claude-autopilot deploy` with no config gives a clear error

---

## Task 8: Tests

### Task 8a: `tests/deploy-vercel.test.ts` (≥8 tests)

- [ ] **Test: success path** — mock fetch returns `{ id: 'dpl_x', url: 'foo.vercel.app' }` for POST then `{ state: 'READY' }` for GET; expect `status: 'pass'`, `deployId`, `deployUrl`
- [ ] **Test: build failure** — mock GET returns `{ state: 'ERROR' }`; expect `status: 'fail'`
- [ ] **Test: auth failure (401)** — mock POST returns 401; expect `GuardrailError` with `code: 'auth'`
- [ ] **Test: project not found (404)** — mock POST returns 404; expect `GuardrailError` with `code: 'invalid_config'`
- [ ] **Test: missing token** — instantiate adapter with no `token` and `delete process.env.VERCEL_TOKEN`; expect `GuardrailError` with `code: 'auth'`
- [ ] **Test: network blip retry** — mock POST throws once then returns success; expect 2 calls and final success
- [ ] **Test: status poll** — call `adapter.status({ deployId: 'dpl_x' })`; assert URL hit and shape returned
- [ ] **Test: ready-state extraction** — verify `READY` → `'pass'`, `CANCELED` → `'fail'`, `BUILDING` mid-poll then `READY`
- [ ] **Test: poll timeout** — set `maxPollMs: 100`, mock GET to always return `BUILDING`; expect `status: 'in-progress'`
- [ ] All tests stub `fetch` via constructor injection — no `globalThis.fetch` mutation

### Task 8b: `tests/deploy-generic.test.ts` (2 tests)

- [ ] **Test: command success** — inject a `spawnImpl` that emits stdout `Deployed: https://foo.example/` and exits 0; expect `status: 'pass'` + `deployUrl`
- [ ] **Test: command failure** — inject spawn that exits non-zero; expect `status: 'fail'`

### Task 8c: `tests/deploy-config-schema.test.ts` (3 tests)

- [ ] **Test: accepts vercel deploy block**
- [ ] **Test: accepts generic deploy block**
- [ ] **Test: rejects invalid adapter value**

### Task 8d: `tests/deploy-types.test.ts` (1 test)

- [ ] **Test: interface exports** — import all named exports from `src/adapters/deploy/types.ts` and assert they exist as types/values that import without error

**Acceptance:**
- All new tests pass via `npm test`
- Total test count increases by ≥14 (was 865, target ≥879)

---

## Task 9: Verification

- [ ] Run `npm test` — full suite passes, count increased
- [ ] Run `npx tsc --noEmit` — no NEW errors in any file touched
- [ ] Run `npm run build` — compiles cleanly to `dist/`
- [ ] Manual smoke: `node dist/src/cli/index.js deploy` (no config) prints clear error
- [ ] Manual smoke: `node dist/src/cli/index.js deploy --adapter vercel` (no token) throws auth error with helpful pointer

---

## Out of Scope (deferred to Phase 2/3)

- Log streaming (`watchBuildLogs: true` is accepted in schema but unused in Phase 1)
- Rollback (`adapter.rollback()` not implemented; `rollbackOn` accepted in schema but unused)
- Auto-detection from `.vercel/project.json`
- `claude-autopilot deploy status <id>` CLI subcommand (basic adapter `status()` exists, but no CLI subcommand wires it up — covered by Phase 5 of spec)
- `--watch` CLI flag

---

## Risk / Rollback

- **Risk:** Adding `deploy` to schema might break configs that use `additionalProperties: false` strictness. Mitigation: schema already has `additionalProperties: false` at root, so adding `deploy` as an optional property is purely additive.
- **Risk:** New CLI subcommand could collide with future `deploy` keyword. Mitigation: `deploy` is the spec'd verb name; reserved.
- **Rollback:** All changes are additive — revert by deleting `src/adapters/deploy/`, `src/cli/deploy.ts`, the `deploy` schema/type entries, and the `case 'deploy'` block in index.ts.
