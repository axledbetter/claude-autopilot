# alpha.7 — Hook Installer, Snapshot Viewer, and Real Baselines

## Goal

Three additions that complete the auto-regression loop:

1. **`autopilot hook install`** — writes a `pre-push` git hook that runs `autoregress run` before every push, catching regressions locally before CI
2. **`autoregress diff`** — snapshot viewer that shows colored JSON diffs between current output and baseline, instead of just pass/fail
3. **`autoregress generate --files <list>`** — explicit file list flag that bypasses git detection, used to generate real baselines for the alpha.6 snapshot modules themselves

---

## Feature 1: `autopilot hook install`

### CLI

```
autopilot hook install          # write .git/hooks/pre-push, chmod +x
autopilot hook install --force  # overwrite existing hook
autopilot hook uninstall        # remove the hook
autopilot hook status           # show whether hook is installed
```

New subcommand `hook` with four sub-subcommands. Entry in `src/cli/index.ts` dispatches to `src/cli/hook.ts`.

### Hook content written to `.git/hooks/pre-push`

```bash
#!/bin/sh
# autopilot pre-push hook — runs impact-selected snapshots before push
npx tsx scripts/autoregress.ts run
```

### `src/cli/hook.ts`

Exports `runHook(subcommand: string, options: { force?: boolean }): Promise<number>`

- `install`: find `.git/` dir (walk up from `cwd`), write hook, chmod 0o755. If hook already exists and `--force` not set: print warning, exit 1.
- `uninstall`: remove hook file if it exists, print confirmation.
- `status`: print whether hook is installed + its content.

---

## Feature 2: `autoregress diff`

### CLI

```
npx tsx scripts/autoregress.ts diff            # diff impacted snapshots
npx tsx scripts/autoregress.ts diff --all      # diff all snapshots
npx tsx scripts/autoregress.ts diff --snapshot sarif  # diff one
```

### Behavior

For each selected snapshot:
1. Run the snapshot in `CAPTURE_BASELINE=1` mode writing to a temp file (not the real baseline)
2. Load existing baseline
3. Compare: if identical → print `  ✓ no changes`; if different → print a line-by-line colored diff
4. Never modifies real baselines (that's `update`)

### Diff output format

```
  tests/snapshots/sarif.snap.ts
    - "level": "warning",
    + "level": "note",
```

Uses ANSI colors: green `+`, red `-`, dim context. Falls back to plain text if `NO_COLOR` or `!process.stdout.isTTY`.

### Implementation

`cmdDiff(args: string[]): number` added to `scripts/autoregress.ts`.

Capture-to-temp: run `spawnSync` with `CAPTURE_BASELINE=1` and `AUTOREGRESS_BASELINE_OVERRIDE=/tmp/...` env var. The snapshot file template in `GENERATE_PROMPT` already uses `fileURLToPath(new URL('./baselines/...'))` — we add a new env check: if `AUTOREGRESS_BASELINE_OVERRIDE` is set, write there instead.

Wait — generated snapshots use the hardcoded `new URL('./baselines/{slug}.json', import.meta.url)` path. We can't override that without modifying every generated file. Simpler approach: `cmdDiff` temporarily symlinks (or copies) baselines to a temp dir, runs snapshot with CAPTURE mode pointing at temp dir, then diffs temp output against real baseline.

**Actual implementation**: capture by running the snapshot in capture mode to a temp baselines dir, then `diff` against the real baselines dir. Concretely:
1. `mkdtempSync` for a temp baselines dir
2. Copy real baseline into it
3. Run snapshot with `CAPTURE_BASELINE=1` — since snapshot writes to `new URL('./baselines/...')` relative to its own file, we actually need a symlink approach

**Simplest correct approach**: run snapshot twice:
- Pass 1: capture mode → produces current output in real baselines location (backup first)
- Pass 2: restore backup, compare two JSON files

Actually the cleanest: run snapshot in capture mode into a temp path by using an env var `AUTOREGRESS_CAPTURE_PATH` — and update `GENERATE_PROMPT` so newly generated snapshots check this env var. For existing snapshots, use a diff approach based on `autoregress run` + captured output.

**Final decision** (pragmatic): `cmdDiff` uses a simple two-step:
1. Run the snapshot module's functions directly via a small harness script that calls them and returns JSON — but that requires knowing the function signatures.

**Actually simplest**: run `autoregress run` and parse the output (pass vs fail), then for failures show what changed by running the snapshot in capture mode to a temp file and diffing against baseline.

Given the complexity of injecting into generated snapshot output, let's scope diff to: run each snapshot in normal mode, and for failures show the JSON diff by running in capture mode to a temp path using `AUTOREGRESS_TEMP_BASELINE_DIR` env var. Update GENERATE_PROMPT to support this env var.

---

## Feature 3: `autoregress generate --files <list>`

### CLI

```
npx tsx scripts/autoregress.ts generate --files src/snapshots/serializer.ts,src/formatters/sarif.ts
```

Bypasses git diff entirely. `--files` takes a comma-separated list of src paths. Mutually exclusive with `--since`.

### Use after alpha.7 ships

```bash
npx tsx scripts/autoregress.ts generate --files \
  src/snapshots/serializer.ts,src/snapshots/import-scanner.ts,\
  src/snapshots/impact-selector.ts,src/formatters/sarif.ts
```

This generates real `.snap.ts` files + baselines for the four core alpha.6 modules, committed to the repo as living documentation.

---

## Architecture Changes

```
src/cli/
  hook.ts          NEW — autopilot hook install/uninstall/status
  index.ts         MODIFY — add 'hook' subcommand dispatch

scripts/
  autoregress.ts   MODIFY — add cmdDiff, add --files to cmdGenerate,
                            update GENERATE_PROMPT with AUTOREGRESS_TEMP_BASELINE_DIR
```

---

## Tests

```
tests/cli/
  hook.test.ts     New: 4 tests — install writes file, install --force overwrites,
                   uninstall removes, status reports correctly

tests/autoregress/
  diff.test.ts     New: 3 tests — identical baseline shows no-change, changed output
                   shows diff lines, missing baseline handled gracefully
```

---

## What Does Not Change

- `src/snapshots/` — no changes
- `tests/snapshots/` registry files — rebuilt by generate
- `scripts/test-runner.mjs` — unchanged

