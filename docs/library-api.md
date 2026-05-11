# Library API — `@delegance/claude-autopilot`

> **Audience:** Node consumers (especially the v8 daemon) that want to
> embed claude-autopilot in-process rather than spawning the CLI as a
> subprocess.

## Stability contract

Anything in this doc is the supported library surface. Changes to the
documented function signatures are SemVer-major. Internal refactors that
keep the documented shape are SemVer-minor or patch.

Anything NOT in this doc but reachable via deep paths
(`@delegance/claude-autopilot/dist/...`) is unsupported and may change
without notice.

## Install

```bash
npm install @delegance/claude-autopilot
```

You usually want it as a `dependency` (not `devDependency`) because
runtime code calls into it.

## Usage

```ts
import {
  detectProject,
  runScaffold,
  runValidate,
  runScan,
} from '@delegance/claude-autopilot';

// Detect the project's stack.
const detection = detectProject(process.cwd());
console.log(`stack: ${detection.preset} (${detection.confidence})`);

// Scaffold a project skeleton from a spec markdown.
const result = await runScaffold({
  cwd: process.cwd(),
  specPath: 'docs/specs/my-feature.md',
});
console.log(`created ${result.filesCreated.length} files`);

// Run static + LLM review on changed files (returns process exit code).
const code = await runValidate({ cwd: process.cwd() });
process.exit(code);
```

## Exported functions

### Pipeline (read-only / discovery)

| Function | Purpose | Returns |
|---|---|---|
| `runScan(opts)` | Run static rules + LLM review on a path | `Promise<number>` (exit code) |
| `runScaffold(opts)` | Scaffold project skeleton from a spec markdown's `## Files` section | `Promise<ScaffoldResult>` |
| `runValidate(opts)` | Run pipeline validate phase (autofix, tests, codex, gate) | `Promise<number>` |
| `runFix(opts)` | Apply LLM patches to cached findings | `Promise<number>` |
| `runCosts(opts)` | Show per-run cost summary | `Promise<number>` |
| `runReport(opts)` | Render cached findings as markdown | `Promise<number>` |
| `runDoctor()` | Check prerequisites (deps, env vars, LLM keys) | `Promise<number>` |
| `runSetup(opts)` | Auto-detect stack, write config, install pre-push hook | `Promise<void>` |

### Pipeline (side-effecting — wrap with policy gates)

| Function | Purpose | Returns |
|---|---|---|
| `runDeploy(opts)` | Deploy via configured adapter (vercel/fly/render/generic) | `Promise<number>` |
| `runDeployStatus(opts)` | Check current deployment status | `Promise<number>` |
| `runDeployRollback(opts)` | Roll back to previous deployment | `Promise<number>` |

The v8 daemon spec calls these "side-effecting" because they make external
state changes (push to a hosting provider). Daemon callers should run
these inside a sandbox + policy gate — see `docs/specs/v8.0-standalone-daemon.md`.

### Helpers

| Function | Purpose | Returns |
|---|---|---|
| `detectProject(cwd)` | Run stack detection on a directory | `DetectionResult` |

## Exported types

* `Finding`, `Severity`, `FindingSource` — for consumers that need to
  inspect or filter findings.
* `RunResult`, `RunInput`, `PhaseResult` — pipeline run shapes.
* `GuardrailConfig`, `AdapterRef`, `AdapterReference` — config schema.
* `DetectionResult` — return shape from `detectProject`.
* `ScaffoldOptions`, `ScaffoldResult` — for `runScaffold` callers.
* `SetupOptions`, `ProfileName` — for `runSetup` callers.

## Deliberate non-exports

These are **callable** via deep imports but not part of the supported
library API. v7.x may move or rename them without warning.

* JSON-envelope wrappers (`runUnderJsonMode`,
  `runAutopilotWithJsonEnvelope`) — CLI-shape helpers for `--json` flag
  output. Library consumers handle their own JSON.
* Internal helpers prefixed with `_` (test seams).
* The full `runs` / `runs-watch` engine introspection group. Engine
  state is its own surface area; will be exposed as
  `@delegance/claude-autopilot/run-state` once the v8 daemon nails down
  what it actually needs.

## Versioning policy

The library API follows the package SemVer:

* **Major (8.0)** — backward-incompatible signature change to any function in this doc.
* **Minor (7.3 → 7.4)** — new function added, existing signatures unchanged.
* **Patch (7.3.0 → 7.3.1)** — bug fixes, internal refactors.

Functions reachable only via deep paths are NOT covered by this policy.

## Why this exists

The v8 daemon (per `docs/specs/v8.0-standalone-daemon.md`) needs to call
into the autopilot pipeline without spawning subprocesses — subprocess
boundaries lose error context, double up dependency resolution, and
(critically for v8 C3) make sandbox enforcement harder. A library API
lets the daemon import `runScaffold` etc directly, then wrap them in
its own policy + sandbox layer.

This export surface is a v8 prerequisite. It deliberately starts small
— eight runtime exports + helpers — and will grow as v8 implementation
identifies more needs.
