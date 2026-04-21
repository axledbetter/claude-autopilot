# alpha.5 — SARIF Output + GitHub Actions Integration

## Goal

Surface `autopilot run` findings as SARIF 2.1.0 (GitHub Code Scanning) and inline PR annotations (GitHub Actions workflow commands), with a composite `action.yml` that wires both with zero user config.

## Architecture

Three new pieces, no new runtime dependencies:

```
src/formatters/
  sarif.ts              pure: RunResult → SarifLog (SARIF 2.1.0)
  github-annotations.ts pure: Finding[] → stdout workflow commands
  index.ts              re-exports both

action.yml              composite action at repo root
```

CLI changes to `src/cli/run.ts` and `src/cli/index.ts` only — no changes to pipeline internals.

## `src/formatters/sarif.ts`

**Signature:** `toSarif(result: RunResult, opts: { toolVersion: string; cwd?: string }): SarifLog`

**Output shape (SARIF 2.1.0):**
```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "claude-autopilot",
        "version": "<toolVersion>",
        "informationUri": "https://github.com/axledbetter/claude-autopilot",
        "rules": [/* one entry per unique finding.category */]
      }
    },
    "results": [/* one entry per finding */]
  }]
}
```

**Rules:** Deduplicated from `result.allFindings` by `finding.category`. Each rule:
```json
{ "id": "category", "name": "category", "shortDescription": { "text": "category" } }
```

**Results:** Each finding maps to:
```json
{
  "ruleId": "finding.category",
  "level": "error|warning|note",
  "message": { "text": "finding.message" },
  "locations": [{
    "physicalLocation": {
      "artifactLocation": { "uri": "<normalized-relative-path>", "uriBaseId": "%SRCROOT%" },
      "region": { "startLine": 10 }   // omitted when finding.line is undefined
    }
  }],
  "fixes": [{ "description": { "text": "finding.suggestion" } }]  // omitted when no suggestion
}
```

**Severity mapping:** `critical → error`, `warning → warning`, `note → note`

**URI normalization** via `normalizeSarifUri(file: string, cwd: string): string`:
- If absolute, make relative to `cwd` via `path.relative()`
- Replace all `\` with `/` (Windows)
- Strip leading `./`
- Result must never start with `../` (findings outside cwd are left as-is with forward slashes)

**Empty findings:** Always produces valid SARIF with `results: []` — never omitted. This ensures `upload-sarif` never fails on a missing or empty file.

**Types:** Inline in `sarif.ts` — no `@types/sarif` dependency.

## `src/formatters/github-annotations.ts`

**Signature:** `emitAnnotations(findings: Finding[]): void`

Writes GitHub Actions workflow commands to `process.stdout`. Only runs when `process.env.GITHUB_ACTIONS === 'true'`; no-ops otherwise.

**Command format:**
```
::error file=src/foo.ts,line=10,endLine=10,title=category::message text here
::warning file=src/foo.ts,line=10,endLine=10,title=category::message text here
::notice file=src/foo.ts,line=10,endLine=10,title=category::message text here
```

Severity mapping: `critical → error`, `warning → warning`, `note → notice`

**Encoding** via `encodeAnnotationValue(s: string): string` — all values (file, title, message) must be encoded before insertion:
| Input | Encoded |
|---|---|
| `%` | `%25` |
| `\r` | `%0D` |
| `\n` | `%0A` |
| `:` | `%3A` |
| `,` | `%2C` |

`encodeAnnotationProperty` (for metadata like `file=`, `line=`) also escapes `,` and `:`. `encodeAnnotationData` (for message after `::`) only needs `%`, `\r`, `\n`.

When `finding.line` is undefined, `line=` and `endLine=` properties are omitted.

## CLI Changes

### `--format` and `--output` flags (`src/cli/index.ts`)

Added to the `run` subcommand:
- `--format text|sarif` — output format (default `text`)
- `--output <path>` — file path for SARIF output (required when `--format sarif`; error if omitted)

Validation: if `--format sarif` and no `--output`, print error and `process.exit(1)`.

### `runCommand()` changes (`src/cli/run.ts`)

New options on `RunCommandOptions`:
```typescript
format?: 'text' | 'sarif';
outputPath?: string;
```

After `runAutopilot()` returns:
1. If `format === 'sarif'`: call `toSarif(result, { toolVersion, cwd })`, write JSON to `outputPath` via `fs.writeFileSync`
2. Always: if `process.env.GITHUB_ACTIONS === 'true'`, call `emitAnnotations(result.allFindings)`
3. Always: print text summary to console (unchanged behavior)
4. Return exit code (unchanged: 0 = pass/warn, 1 = fail)

`toolVersion` is read from the package's own `package.json` via `JSON.parse(fs.readFileSync(...))`.

## `action.yml`

```yaml
name: Claude Autopilot
description: >
  Run the autopilot pipeline on changed files, upload findings to GitHub Code
  Scanning (SARIF), and annotate the PR diff inline.
author: axledbetter

inputs:
  config:
    description: Path to autopilot.config.yaml
    default: autopilot.config.yaml
  version:
    description: Package version to install (e.g. 1.0.0-alpha.5, latest, alpha)
    default: alpha
  sarif-output:
    description: Path to write SARIF results file
    default: autopilot-results.sarif
  openai-api-key:
    description: OpenAI API key for review engine (pass via secrets)
    required: false

runs:
  using: composite
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: npm

    - name: Install autopilot
      run: npx -y @delegance/claude-autopilot@${{ inputs.version }} --version || true
      shell: bash

    - name: Run autopilot pipeline
      run: >
        npx -y @delegance/claude-autopilot@${{ inputs.version }}
        run
        --config ${{ inputs.config }}
        --format sarif
        --output ${{ inputs.sarif-output }}
      shell: bash
      env:
        OPENAI_API_KEY: ${{ inputs.openai-api-key }}

    - name: Upload SARIF to GitHub Code Scanning
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: ${{ inputs.sarif-output }}
```

**Caller example** (`.github/workflows/autopilot.yml`):
```yaml
on: [pull_request]
jobs:
  autopilot:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: axledbetter/claude-autopilot@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Note: `actions/checkout@v4` is included inside the composite action, so callers do not need a separate checkout step.

## Tests

### `tests/formatters/sarif.test.ts` (11 tests)

| ID | Description |
|---|---|
| S1 | Empty findings → valid SARIF with `results: []`, correct `$schema` and `version` |
| S2 | `critical` finding → `level: "error"` |
| S3 | `warning` finding → `level: "warning"` |
| S4 | `note` finding → `level: "note"` |
| S5 | Finding with `line` → `region.startLine` set |
| S6 | Finding without `line` → no `region` property |
| S7 | Two findings same category → one rule entry in `driver.rules` |
| S8 | `suggestion` present → `fixes[0].description.text` set |
| S9 | Absolute path → normalized to repo-relative forward-slash |
| S10 | Windows backslash path → normalized to forward-slash |
| S11 | `./`-prefixed path → leading `./` stripped |

### `tests/formatters/github-annotations.test.ts` (8 tests)

| ID | Description |
|---|---|
| A1 | `critical` → `::error` command |
| A2 | `warning` → `::warning` command |
| A3 | `note` → `::notice` command |
| A4 | Finding with `line` → `file=...,line=N,endLine=N` |
| A5 | Finding without `line` → no `line=` property |
| A6 | Empty findings → no output |
| A7 | Message with `%`, newline, comma → properly percent-encoded |
| A8 | `GITHUB_ACTIONS` not set → no-op (nothing written) |

Total: 19 new tests, **93 total**.

## What Does Not Change

- `runAutopilot()` API — no changes to pipeline internals
- Exit codes — `0` pass/warn, `1` fail (unchanged)
- `--format text` output — identical to today
- All existing tests pass unmodified
