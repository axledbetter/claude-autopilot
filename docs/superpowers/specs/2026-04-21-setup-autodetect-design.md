# `autopilot setup` — Zero-Question Auto-Detect Setup

## Goal

Single command that gets a new user fully configured with no prompts:
```bash
npx autopilot setup
```

## What It Does

1. Detect project type from filesystem signals
2. Pick the matching preset automatically
3. Infer test command from project files
4. Write `autopilot.config.yaml` with detected testCommand injected
5. Install the pre-push git hook
6. Print a clear summary of what was done

## Detection Logic

Priority order (first match wins):

| Signal | Preset | testCommand |
|---|---|---|
| `go.mod` exists | `go` | `go test ./...` |
| `Gemfile` contains `'rails'` | `rails-postgres` | `bundle exec rails test` |
| `requirements.txt`/`pyproject.toml` contains `fastapi` | `python-fastapi` | `pytest` |
| `package.json` + `@trpc/server` dep | `t3` | from scripts.test or `npm test` |
| `package.json` + `next` + `@supabase/supabase-js` | `nextjs-supabase` | from scripts.test or `npm test` |
| `package.json` + `next` | `nextjs-supabase` | from scripts.test or `npm test` |
| `package.json` (any) | `nextjs-supabase` | from scripts.test or `npm test` |
| nothing matched | `nextjs-supabase` | `npm test` |

Confidence: `high` when a strong signal matches (go.mod, rails, fastapi, @trpc/server, next+supabase), `low` otherwise.

## Output

```
[setup] Detecting project type...
  ✓  Next.js + Supabase (found next.config.ts, @supabase/supabase-js)
  ✓  Test command: npm test (from package.json)
  ✓  Created autopilot.config.yaml
  ✓  Installed pre-push git hook

[setup] Done. Run: npx autopilot run
```

On low confidence:
```
  !  No strong signals found — defaulted to nextjs-supabase preset
     Edit autopilot.config.yaml to switch presets if needed
```

If `autopilot.config.yaml` already exists: error with hint to use `--force`.

## Architecture

```
src/cli/detector.ts     — detectProject(cwd) → DetectionResult
src/cli/setup.ts        — runSetup(options) — orchestrates detect → write → hook
src/cli/index.ts        — add 'setup' case + --force flag
```

`testCommand` is injected by appending `testCommand: "<cmd>"` to the preset YAML content (the field is absent from preset files, so a simple append works cleanly — no regex replacement needed).
