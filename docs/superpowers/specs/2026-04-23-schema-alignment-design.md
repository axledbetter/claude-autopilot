# schema-alignment Static Rule — Design

## Goal

Add a `schema-alignment` static rule to `@delegance/guardrail` that detects when migration or schema files are modified and checks that the change is reflected across all three layers: type definitions, API/backend routes, and UI components. Works across Supabase, Prisma, Rails, Drizzle, and Django without hardcoding any single project structure.

## Architecture

```
src/core/static-rules/rules/schema-alignment.ts   ← thin orchestrator (~30 lines)

src/core/schema-alignment/
  detector.ts        ← filter touchedFiles → migration/schema file paths
  extractor/
    index.ts         ← dispatch by file extension
    sql.ts           ← tokenizer: CREATE/ALTER TABLE, ADD/DROP/RENAME COLUMN, CREATE/ALTER TYPE
    prisma.ts        ← parse model/field declarations from schema.prisma
  scanner.ts         ← search type/API/UI layers; return Evidence per layer
  llm-check.ts       ← scoped LLM call for semantic alignment; skippable
  types.ts           ← SchemaEntity, LayerScanResult, Evidence, AlignmentFinding
```

### Modified files

| File | Change |
|------|--------|
| `src/core/static-rules/registry.ts` | Add `'schema-alignment'` entry (builtin) |
| `src/core/config/types.ts` | Add `schemaAlignment?: SchemaAlignmentConfig` to `GuardrailConfig` |

## Detection

`detector.ts` accepts `touchedFiles: string[]` and returns the subset matching known migration/schema globs:

| Stack | Default globs |
|-------|--------------|
| Supabase | `data/deltas/**/*.sql`, `supabase/migrations/**/*.sql` |
| Prisma | `prisma/migrations/**/*.sql`, `prisma/schema.prisma` |
| Rails | `db/migrate/**/*.rb` |
| Drizzle | `drizzle/**/*.ts` |
| Django | `*/migrations/*.py` |

Config `migrationGlobs` array is **appended** to the auto-detected set (not replaced), so project-specific paths layer on top.

Returns `string[]` of matched absolute paths. Empty array means rule is a no-op for this run.

## Extraction

`extractor/index.ts` dispatches by file extension:
- `.sql` → `sql.ts`
- `.prisma` → `prisma.ts`
- `.rb`, `.ts`, `.py` → future extractors (no-op for now, logged to stderr)

### `extractor/sql.ts`

Minimal tokenizer (not free-form regex) that recognises these statement patterns:

```
CREATE [OR REPLACE] TABLE [IF NOT EXISTS] <name>
ALTER TABLE <name> ADD [COLUMN] <col> <type>
ALTER TABLE <name> DROP [COLUMN] [IF EXISTS] <col>
ALTER TABLE <name> RENAME [COLUMN] <old> TO <new>
CREATE TYPE <name> / ALTER TYPE <name> ADD VALUE
```

Returns `SchemaEntity[]`:

```typescript
interface SchemaEntity {
  table: string;
  column?: string;
  operation: 'create_table' | 'add_column' | 'drop_column' | 'rename_column' | 'create_type';
  oldName?: string; // rename only
}
```

### `extractor/prisma.ts`

Parses `schema.prisma` for `model <Name> { ... }` blocks and extracts field names. For Prisma migration SQL files, delegates to `sql.ts`.

## Layer Scanning

`scanner.ts` searches three configurable layer roots for each `SchemaEntity`:

| Layer | Default roots | Strong-signal patterns |
|-------|--------------|----------------------|
| Type | `types/`, `src/types/`, `lib/types/` | Property access `entity.col`, Zod `z.object({ col: ... })`, interface/type field declaration |
| API | `app/api/`, `lib/`, `services/`, `src/routes/` | `.select('col')`, `.eq('col', ...)`, `.insert({ col })`, ORM model reference |
| UI | `app/`, `src/`, `components/` | JSX `{data.col}`, form field name, display reference |

`layerRoots` config overrides these defaults entirely per layer.

Returns `LayerScanResult`:

```typescript
interface LayerScanResult {
  entity: SchemaEntity;
  typeLayer: Evidence | null;
  apiLayer: Evidence | null;
  uiLayer: Evidence | null;
}

interface Evidence {
  file: string;
  line: number;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}
```

- `null` means no evidence found in that layer — potential drift
- `drop_column` and `rename_column` operations invert the check: evidence of the **old** name in any layer is a finding

## LLM Check

`llm-check.ts` runs only when structural scan returns `null` for at least one layer. It does not run on clean scans.

**Input budget:** 6000 chars total — migration file content first, then layer file snippets truncated to fit. Same top-truncation strategy as `context.ts` (drop oldest/top content, keep recent).

**System prompt:** frames the LLM as a schema-alignment reviewer. Asks it to identify missing updates or stale field names in the provided layer files.

**Returns:** `AlignmentFinding[]`:

```typescript
interface AlignmentFinding {
  entity: SchemaEntity;
  layer: 'type' | 'api' | 'ui';
  message: string;
  file?: string;
  severity: 'warning' | 'error';
  confidence: 'high' | 'medium' | 'low';
}
```

When `llmCheck: false`, structural gaps still emit `AlignmentFinding` at `confidence: 'medium'` with a generic "no reference found" message.

Destructive operations (`drop_column`, `rename_column`) always emit severity `'error'` regardless of confidence.

## Config

```yaml
# guardrail.config.yaml
schema-alignment:
  enabled: true
  migrationGlobs:              # appended to auto-detected globs
    - "custom/schema/**/*.sql"
  layerRoots:                  # override per-layer search roots
    types: ["types/", "src/types/"]
    api: ["app/api/", "lib/"]
    ui: ["app/", "components/"]
  llmCheck: true               # false = structural scan only (faster CI mode)
  severity: warning            # warning | error (default finding severity)
```

Validation rules (Zod):
- `migrationGlobs` items must be non-empty strings
- `severity` must be `'warning'` or `'error'`
- `layerRoots.*` arrays must be non-empty if provided

## Rule Orchestrator

`rules/schema-alignment.ts`:

```
check(touchedFiles, config):
  1. detector.detect(touchedFiles, config.schemaAlignment) → migrationFiles
  2. if migrationFiles.length === 0: return []
  3. for each migrationFile: extractor.extract(migrationFile) → entities[]
  4. scanner.scanLayers(entities, cwd, config.schemaAlignment) → scanResults[]
  5. gapResults = scanResults.filter(r => r.typeLayer === null || r.apiLayer === null || r.uiLayer === null)
  6. if gapResults.length === 0: return []  // structurally clean
  7. if llmCheck: llmCheck.run(migrationFiles, gapResults, engine) → llmFindings[]
  8. else: gapResults.map(toStructuralFinding)
  9. return findings as Finding[]
```

## Testing

### Unit tests

- `detector.ts` — SQL glob matched, prisma schema.prisma matched, config override appended, non-migration file not matched
- `extractor/sql.ts` — CREATE TABLE, ADD COLUMN, DROP COLUMN, RENAME COLUMN each produce correct `SchemaEntity`; handles `IF NOT EXISTS`, quoted identifiers, multi-statement files
- `extractor/prisma.ts` — model/field names parsed from fixture `schema.prisma`
- `scanner.ts` — entity found in type layer (returns Evidence), missing from API (returns null); `drop_column` finds old name = finding
- `llm-check.ts` with mock engine — called when gaps exist, skipped when `llmCheck: false`, respects token budget (6000 chars)

### Integration / snapshot tests

- Fixture: Supabase project with `data/deltas/20260423_add_status.sql` (ADD COLUMN status), type file missing the field → snapshot of expected `AlignmentFinding[]`
- Fixture: Prisma project with `prisma/migrations/20260423_rename_col.sql` (RENAME COLUMN old → new), API file still uses old name → finding emitted
- Fixture: clean run (all three layers reference the new column) → `[]`

### Rule registration test

- `schema-alignment` listed in registry, `check()` callable with minimal fixture workspace
