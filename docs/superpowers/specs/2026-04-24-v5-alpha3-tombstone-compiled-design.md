# Spec — v5.0.0-alpha.3 (tombstone + compiled entrypoint + codemod)

**Date:** 2026-04-24
**Status:** Approved (inherits from alpha.2 spec's "Still deferred to alpha.3" list)
**Target release:** `5.0.0-alpha.3`, the final alpha before `5.0.0` GA.

## Problem

Alpha.2 left the `@delegance/guardrail` tombstone unpublished, the bin runtime dependent on `tsx`, and v4 users without a mechanical way to migrate their repos. These are the last blockers to a clean 5.0.0 GA.

## Goals

1. **Compiled JS entrypoint.** Drop the `tsx` runtime dependency for global installs. Ship `dist/cli/index.js` in the tarball; bin prefers the compiled output, falls back to `src/` + `tsx` only in dev.
2. **Tombstone `@delegance/guardrail@5.0.0`.** A separate minimal package that ships a `guardrail` bin forwarding to `@delegance/claude-autopilot` with strict argv / stdout / stderr / exit-code passthrough. Users who pin `@delegance/guardrail` get a thin wrapper that invokes the new package on their behalf.
3. **Codemod — `claude-autopilot migrate-v4 [--write]`.** Scans a target repo for `@delegance/guardrail` + `guardrail` CLI invocations, proposes replacements, applies with `.v4-backup` files when `--write`. Covers `package.json`, shell scripts, GitHub Actions yaml, Dockerfiles, Claude Code skills.
4. **CI bin-parity smoke tests.** New `.github/workflows/bin-parity.yml` — on every push to master + PR, exercise `npx @alpha`, global install, and both bin names on ubuntu + macos.
5. **Error prefix cleanup.** Normalize `[guardrail]` → `[claude-autopilot]` in user-facing messages. Legacy `[guardrail]` string retained only in the bin-wrapper deprecation notice and the legacy skill file.

**Non-goals for alpha.3:** the full CLI verb restructure beyond the additive aliases shipped in alpha.2. That can slip to 5.0.1 without blocking GA.

## Design

### Compiled JS entrypoint

**`package.json`:**
```jsonc
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "npm run build && npm test"
  },
  "files": [
    "bin/",
    "src/",           // kept for dev / IDE source nav
    "dist/",          // NEW — compiled output
    "presets/",
    "skills/",
    "scripts/test-runner.mjs",
    "scripts/autoregress.ts",
    "scripts/snapshots/",
    "tests/snapshots/",
    "CHANGELOG.md",
    "README.md"
  ]
}
```

**New `tsconfig.build.json`:**
```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "noEmit": false,
    "declaration": false,
    "sourceMap": true,
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "tests/**"]
}
```

**`bin/_launcher.js` — prefer compiled output:**
```js
// Prefer ../dist/cli/index.js (compiled, no tsx needed). Fall back to
// ../src/cli/index.ts + tsx for dev workflows in the repo itself.
function resolveEntrypoint() {
  const compiled = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');
  if (fs.existsSync(compiled)) return { kind: 'compiled', path: compiled };
  const source = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');
  return { kind: 'source', path: source };
}
```

When `kind === 'compiled'`, spawn with `node <compiled>`. When `kind === 'source'`, spawn with tsx as before. Global `npm install` ships `dist/` so compiled path always resolves for end users.

**Risk:** `.ts` file imports in source code use explicit `.ts` extensions (e.g. `import from '../foo.ts'`) — tsc's default emit would break these. Mitigation: `"moduleResolution": "bundler"` in tsconfig.build.json OR post-build rewrite. Real alpha soak against delegance-app will catch any regression.

### Tombstone `@delegance/guardrail@5.0.0`

Structure (in-monorepo, separately publishable):
```
packages/
└── guardrail-tombstone/
    ├── package.json     # name: "@delegance/guardrail", version: "5.0.0"
    ├── bin/
    │   └── guardrail.js # thin wrapper
    ├── README.md        # "Package renamed — see @delegance/claude-autopilot"
    └── .npmignore       # prevent accidental bundling of parent repo files
```

**`packages/guardrail-tombstone/bin/guardrail.js`:**
```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find @delegance/claude-autopilot's bin — co-installed as a dep, or globally,
// or via npx. Strict argv/stdio/exit-code passthrough — no interpretation.
function findClaudeAutopilotBin() {
  const own = path.resolve(__dirname, '..', 'node_modules', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js');
  if (fs.existsSync(own)) return own;
  const hoisted = path.resolve(__dirname, '..', '..', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js');
  if (fs.existsSync(hoisted)) return hoisted;
  return 'claude-autopilot'; // PATH fallback
}

process.stderr.write(
  '\x1b[33m[deprecated]\x1b[0m @delegance/guardrail renamed to @delegance/claude-autopilot. ' +
  'This package is a thin forwarding wrapper — identical behavior. ' +
  'Migration: https://github.com/axledbetter/claude-autopilot/blob/master/docs/migration/v4-to-v5.md\n',
);

const result = spawnSync(findClaudeAutopilotBin(), process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
```

**`packages/guardrail-tombstone/package.json`:**
```jsonc
{
  "name": "@delegance/guardrail",
  "version": "5.0.0",
  "type": "module",
  "description": "[Renamed] This package is now @delegance/claude-autopilot. Installing @delegance/guardrail@5.0.0 gives you a thin wrapper that forwards to the new package.",
  "bin": { "guardrail": "bin/guardrail.js" },
  "dependencies": {
    "@delegance/claude-autopilot": ">=5.0.0"
  },
  "engines": { "node": ">=22.0.0" },
  "files": ["bin/", "README.md"]
}
```

Publish flow: `cd packages/guardrail-tombstone && npm publish`. User runs this manually after alpha.3 ships (scoped to the user's npm auth).

### Codemod — `claude-autopilot migrate-v4`

**`src/cli/migrate-v4.ts`** — new handler registered in the dispatcher.

```
claude-autopilot migrate-v4                 # dry-run, prints report
claude-autopilot migrate-v4 --write         # apply, with .v4-backup files
claude-autopilot migrate-v4 --path <dir>    # target dir (default: cwd)
claude-autopilot migrate-v4 --undo          # restore from .v4-backup files
```

Patterns covered:

| Target | Find | Replace |
|---|---|---|
| `package.json` deps | `"@delegance/guardrail": "..."` | `"@delegance/claude-autopilot": "^5.0.0"` |
| `package-lock.json` | *skipped (regenerated by npm install)* | — |
| Shell scripts (`.sh`, `.bash`, `.zsh`) | `guardrail <cmd>` (word boundary) | `claude-autopilot <cmd>` |
| Makefiles | same | same |
| `.github/workflows/*.yml` | `npm install -g @delegance/guardrail` | `npm install -g @delegance/claude-autopilot@alpha` |
| `.github/workflows/*.yml` | `guardrail run\|scan\|ci` | `claude-autopilot <verb>` |
| Dockerfiles | `npm install -g @delegance/guardrail@...` | `npm install -g @delegance/claude-autopilot@alpha` |
| Claude Code skills | `.claude/skills/guardrail.md` symlink or content ref | no-op (back-compat retained) |

Report format:
```
[migrate-v4] Scanning /path/to/repo...
  package.json              2 replacements
  .github/workflows/ci.yml  3 replacements
  scripts/pre-push.sh       1 replacement
  Dockerfile                1 replacement
  ─────────────────────────────
  7 replacements across 4 files

Run with --write to apply. Backup files (.v4-backup) will be created.
```

Tests: golden fixture under `tests/migrate-v4/fixtures/` with a pre-v4 repo shape; assert the codemod produces exactly the expected `@delegance/claude-autopilot` replacements.

### CI bin-parity smoke tests

**`.github/workflows/bin-parity.yml`:**

```yaml
name: Bin parity smoke
on:
  push:
    branches: [master]
  pull_request:
jobs:
  smoke:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v6
        with: { node-version: '${{ matrix.node }}' }
      - run: npm install -g @delegance/claude-autopilot@alpha
      - name: claude-autopilot bin
        run: |
          OUT=$(claude-autopilot --version)
          echo "$OUT" | grep -E '^5\.[0-9]+\.[0-9]+' || exit 1
      - name: guardrail bin (legacy alias)
        run: |
          OUT=$(CLAUDE_AUTOPILOT_DEPRECATION=never guardrail --version)
          echo "$OUT" | grep -E '^5\.[0-9]+\.[0-9]+' || exit 1
      - name: deprecation notice on stderr
        run: |
          OUT=$(CLAUDE_AUTOPILOT_DEPRECATION=always guardrail --version 2>&1 >/dev/null)
          echo "$OUT" | grep -i deprecated || exit 1
      - name: npx direct
        run: npx --yes @delegance/claude-autopilot@alpha --version
```

Runs on every push to master + every PR. Fails the workflow if any invocation breaks.

### Error prefix cleanup

Grep audit:
```bash
grep -rn "\\[guardrail\\]" src/ | wc -l
```

Expected surfaces to update:
- `src/cli/index.ts` — `[guardrail] Unknown subcommand` → `[claude-autopilot] Unknown subcommand`
- `src/cli/run.ts` / `scan.ts` — most already use phase-name prefixes (`[run]`, `[scan]`), good
- Welcome screen — `@delegance/guardrail` heading → `@delegance/claude-autopilot`
- `src/cli/preflight.ts` — `[doctor] Guardrail prerequisite check` → `[doctor] claude-autopilot prerequisite check`

Keep `[guardrail]` only in:
- `bin/_launcher.js` deprecation notice
- `skills/guardrail.md` (legacy skill file is itself a back-compat surface)

Audit hook: add a test `tests/no-guardrail-prefix.test.ts` that greps the source tree and fails if more than the whitelisted surfaces contain `[guardrail]`.

## Rollout plan

1. Write alpha.3 spec. ✓
2. Compiled JS entrypoint + `tsconfig.build.json` + launcher rewrite.
3. Error prefix cleanup + regression test.
4. Codemod `migrate-v4` + golden fixture.
5. Tombstone package (prep only — Alex publishes).
6. CI bin-parity workflow.
7. Run typecheck, full tests, `npm pack --dry-run`, manual bin smoke.
8. Commit, push `feature/v5-alpha.3`, open PR.
9. Codex review PR → address criticals.
10. Bugbot triage.
11. Merge. Tag `v5.0.0-alpha.3`. Auto-publish.
12. Alex manually publishes `@delegance/guardrail@5.0.0` tombstone.

## Success criteria for alpha.3

- `npm install -g @delegance/claude-autopilot@5.0.0-alpha.3` → both bins work without `tsx` on the global resolver path.
- `claude-autopilot migrate-v4` on a fixture repo produces expected replacements, `--undo` restores cleanly.
- `.github/workflows/bin-parity.yml` green on first run after publish.
- `packages/guardrail-tombstone/` is publish-ready; `npm publish --dry-run` inside it produces a valid tarball that forwards argv correctly.
- `[guardrail]` appears only in whitelisted surfaces per the audit test.
- All existing tests (587 from alpha.2 + new migrate-v4 + new no-prefix tests) pass.

## Open questions

1. **`moduleResolution: bundler` or post-build rewrite for `.ts` extension imports?** ~~Test both.~~ **Decided (per Codex review 2026-04-24):** post-build rewriter. The codebase uses `.ts` import specifiers throughout (~100 files); a mass source rewrite risks breaking dev workflow. Ship `scripts/post-build-rewrite-imports.mjs` that walks `dist/` after `tsc` emit and rewrites `.ts` → `.js` in relative import specifiers. Deterministic, tested, small.
2. **Tombstone package layout — monorepo or separate repo?** Monorepo for alpha.3.
3. **Should `migrate-v4` mutate `package-lock.json` or just `package.json`?** Just `package.json`.

## Codex review revisions (2026-04-24)

Folded in from `/codex-review` before implementation:

- **[CRITICAL] Compiled entrypoint `.ts` imports** — resolved via post-build rewriter (see q#1 above).
- **[CRITICAL] Tombstone path probing unreliable** — use `createRequire(import.meta.url).resolve('@delegance/claude-autopilot/bin/claude-autopilot.js')` as the primary resolver. Falls through to relative-path probe and PATH lookup only when node's resolver fails. Tests cover npm / pnpm / yarn layouts.
- **[WARNING] spawnSync edge cases** — tombstone and legacy bin both handle `result.error`, map `ENOENT` to a clear message + exit 127, forward `result.signal`.
- **[WARNING] CI bin-parity proves dispatch, not passthrough** — add two more steps: (a) invoke a command that exits nonzero, assert exit code forwarded; (b) invoke a command that writes both stdout + stderr, assert stdout and stderr arrive on the expected streams separately.
- **[WARNING] Codemod package.json mutation scope** — explicit: updates `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`. Preserves semver operator shape (^/~/>=/exact). Preserves key ordering.
- **[WARNING] Codemod --undo safety** — write `.claude-autopilot/migrate-v4-manifest.json` containing `{files: [{path, sha256, backupPath, timestamp}]}`. `--undo` requires the manifest and hash-matches before restoring. Prevents stale backups clobbering modified files.
- **[NOTE] Prefix audit test** — scope to `src/cli/**` only (runtime surfaces). Programmatic whitelist in the test file, not shell grep.
- **[NOTE] Tombstone publish manual step** — add to release checklist: GA gate requires `npm view @delegance/guardrail@5.0.0 version` to match + a manual smoke invocation.
