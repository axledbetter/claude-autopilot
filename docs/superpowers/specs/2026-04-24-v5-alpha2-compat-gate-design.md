# Spec — v5.0.0-alpha.2 (compat gate + CLI restructure)

**Date:** 2026-04-24
**Status:** Approved (scope inherits from alpha.1 spec's "Deferred to later alphas" section)
**Target release:** `5.0.0-alpha.2` after alpha.1 soaks briefly.

## Problem

`@delegance/claude-autopilot@5.0.0-alpha.1` shipped the rename but made back-compat promises it hasn't proven ("every v4 invocation continues to work") and left two pipeline assumptions unenforced (superpowers peer dep, CLI verb structure). Alpha.2 closes the gap before 5.0.0 GA.

## Goals

1. **Prove v4 compatibility.** Build a golden-test matrix that exercises the top 20 real v4 invocations against a fixture repo and pins their exit codes + normalized output. Every alpha after this either passes the matrix or is blocked.
2. **Make the superpowers dependency explicit.** Doctor hard-fails with a one-command remediation hint when the required plugin skills aren't resolvable. Add `peerDependencies` in `package.json`.
3. **Restructure CLI verbs.** Group the 27 flat subcommands under ~12 top-level verbs (`review`, `pr`, `triage`, `advanced`, plus pipeline phases). Every legacy flat invocation still works as an alias so the v4 golden tests stay green.

**Non-goals for alpha.2:** tombstone `@delegance/guardrail@5.0.0`, CI bin-parity smoke tests, codemod script. Those land in alpha.3.

## Design

### v4 compatibility golden-test matrix

Location: `tests/v4-compat/`

Structure:
```
tests/v4-compat/
├── fixtures/
│   ├── nextjs-supabase-repo/     # minimal realistic repo
│   ├── generic-repo/              # no framework signals
│   └── with-baseline/             # repo with .guardrail-baseline.json committed
├── golden/                        # normalized output snapshots (one file per invocation)
├── invocations.ts                 # the matrix: [{name, argv, cwd, expectedExitCode, envOverrides?}]
└── v4-compat.test.ts              # runs each invocation + diffs normalized stdout
```

**The 20 pinned invocations:**

1. `guardrail --version` → exit 0, prints version on stdout
2. `guardrail --help` → exit 0, lists subcommands including legacy aliases
3. `guardrail run` → exit 0 or 1 depending on fixture
4. `guardrail run --base main` → same
5. `guardrail run --diff` → same, uses diff chunking
6. `guardrail run --new-only` → exit 0 when no baseline, 1 if new findings
7. `guardrail run --fail-on warning` → elevated fail threshold
8. `guardrail run --format sarif` → SARIF on stdout, exit 0
9. `guardrail run --format junit` → JUnit XML on stdout
10. `guardrail scan src/auth/` → exit 0/1
11. `guardrail scan --ask "is there an IDOR here?" src/api/` → exit 0
12. `guardrail ci` → exit 0/1 (tests + static + review)
13. `guardrail setup --preset generic` → exit 0, writes config
14. `guardrail doctor` → exit 0 when env is clean
15. `guardrail costs` → exit 0, prints table or empty
16. `guardrail explain 3` → exit 0 or 1 (no finding ID 3)
17. `guardrail baseline create` → exit 0, writes baseline
18. `guardrail ignore add "tests/**"` → exit 0, updates config
19. `guardrail fix --dry-run` → exit 0, no writes
20. `guardrail hook install` → exit 0, installs pre-push

**Output normalization:** strip timestamps, durations, absolute paths → `<cwd>`, transient line numbers. Normalized output hashed and compared against golden snapshot.

**Run mode:** every invocation runs with `CLAUDE_AUTOPILOT_DEPRECATION=never` to suppress the stderr deprecation notice. Stderr is captured separately for the `guardrail --version` test to verify the deprecation notice IS emitted when the env override is absent.

**Golden update:** `npm run test:v4-compat -- --update-goldens` regenerates snapshots. Only blessed by a human after visual inspection.

### Superpowers peer dep + doctor hard-fail

**`package.json`:**
```json
{
  "peerDependencies": {
    "superpowers": "*"
  },
  "peerDependenciesMeta": {
    "superpowers": { "optional": true }
  }
}
```

Kept optional so the tarball still installs cleanly; doctor enforces presence for pipeline use.

**`src/cli/preflight.ts` — new check:**
```ts
// Check #7 (new): superpowers skills resolvable
const SUPERPOWERS_SKILLS = [
  'writing-plans',
  'using-git-worktrees',
  'subagent-driven-development',
];
const missing = findMissingSuperpowersSkills();
checks.push({
  name: 'Superpowers plugin',
  result: missing.length === 0 ? 'pass' : 'fail',
  message: missing.length > 0
    ? `Missing skills: ${missing.join(', ')}. Install via: claude plugin install superpowers`
    : undefined,
});
```

Skill resolution checks `~/.claude/plugins/*/skills/<name>` and `<cwd>/.claude/plugins/*/skills/<name>`.

Note: `doctor` treats this as a hard-fail (exit 1 includes it as blocker) only when pipeline skills are invoked. `doctor` alone warns but doesn't exit 1 if superpowers is missing — many users of the review-only path don't need it.

### CLI verb restructure

**Current (alpha.1):**
```
claude-autopilot {run,scan,ci,fix,baseline,ignore,hook,watch,pr,triage,council,costs,doctor,setup,init,explain,report,pr-desc,test-gen,autoregress,lsp,mcp,worker,preflight,detector}
```

**Target (alpha.2):**
```
claude-autopilot
├── review {run,scan,ci,fix,baseline,explain,watch}     # grouped review commands
├── pr {create,comment,desc,review-comments}             # grouped PR commands
├── triage                                               # unchanged
├── council                                              # unchanged (promoted phase)
├── migrate                                              # pipeline phase
├── validate                                             # pipeline phase (wrapper over `review run` + tests)
├── costs | doctor | setup | init | hook                # top-level operational
└── advanced {lsp,mcp,worker,autoregress,test-gen,ignore,detector}  # niche/system
```

**Back-compat:** every flat path still routes to the same handler. Under the hood the dispatcher normalizes both `review run <args>` and `run <args>` to the same code path. No legacy command breaks.

**Implementation:** refactor `src/cli/index.ts` dispatcher so it:
1. Tries the full verb first (`review run` → `review run` handler).
2. Falls back to flat (`run` → `review run` handler).
3. `advanced <cmd>` dispatches to the current handler.

New file `src/cli/verb-map.ts` owns the mapping.

## Rollout plan (alpha.2)

1. Write alpha.2 spec. ✓
2. Update README install instructions to `@alpha` as a safety net for the alpha period.
3. Add superpowers peer dep + doctor check + remediation hint.
4. Build v4 golden-test fixtures + matrix + runner.
5. Restructure CLI verbs (keep flat aliases green, assert via golden matrix).
6. Run `npm run typecheck`, `npm test`, `npm pack --dry-run`. Golden tests must pass.
7. Commit, push `feature/v5-alpha.2`, open PR.
8. Codex review PR → fix criticals.
9. Bugbot triage.
10. Merge. Tag `v5.0.0-alpha.2`. Auto-publish via existing workflow under `alpha` dist-tag.

## Success criteria for alpha.2

- `tests/v4-compat/` exists with 20 pinned invocations, all passing.
- `claude-autopilot doctor` with superpowers uninstalled emits a `✗ Superpowers plugin` check with remediation command.
- `claude-autopilot review run --base main` works AND `claude-autopilot run --base main` works (same output, same exit code).
- Every invocation in the golden matrix passes exit-code + normalized-output parity.
- `npm install -g @delegance/claude-autopilot@alpha` from README → usable out of the box.
