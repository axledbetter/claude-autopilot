# schema-alignment Static Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `schema-alignment` builtin static rule that detects migration/schema file changes and verifies the type, API, and UI layers are all updated consistently.

**Architecture:** A thin rule orchestrator delegates to a `src/core/schema-alignment/` module with four responsibilities: detection (which touched files are migrations), extraction (what entities changed), scanning (are those entities referenced in each layer), and LLM check (semantic validation when structural gaps are found). Config and engine are threaded through by updating `StaticRulesPhaseInput`.

**Tech Stack:** Node.js 22, TypeScript ESM, `node:fs`, `node:path`, `node:test` + `assert/strict`, existing `ReviewEngine` interface.

---

### Task 1: Types

**Files:**
- Create: `src/core/schema-alignment/types.ts`
- Test: none (pure types — tested implicitly by consumers)

- [ ] **Step 1: Create the types file**

```typescript
// src/core/schema-alignment/types.ts

export interface SchemaEntity {
  table: string;
  column?: string;
  operation: 'create_table' | 'add_column' | 'drop_column' | 'rename_column' | 'create_type';
  oldName?: string; // rename_column only: the previous column name
}

export interface Evidence {
  file: string;
  line: number;
  snippet: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface LayerScanResult {
  entity: SchemaEntity;
  typeLayer: Evidence | null;
  apiLayer: Evidence | null;
  uiLayer: Evidence | null;
}

export interface AlignmentFinding {
  entity: SchemaEntity;
  layer: 'type' | 'api' | 'ui';
  message: string;
  file?: string;
  severity: 'warning' | 'error';
  confidence: 'high' | 'medium' | 'low';
}

export interface SchemaAlignmentConfig {
  enabled?: boolean;
  migrationGlobs?: string[];
  layerRoots?: {
    types?: string[];
    api?: string[];
    ui?: string[];
  };
  llmCheck?: boolean;
  severity?: 'warning' | 'error';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/schema-alignment/types.ts
git commit -m "feat(schema-alignment): add types"
```

---

### Task 2: Detector

**Files:**
- Create: `src/core/schema-alignment/detector.ts`
- Test: `tests/schema-alignment-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema-alignment-detector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('schema-alignment detector', () => {
  it('matches supabase data/deltas SQL file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/data/deltas/20260423_add_status.sql', '/project/app/api/users/route.ts'];
    assert.deepEqual(detect(files), ['/project/data/deltas/20260423_add_status.sql']);
  });

  it('matches supabase/migrations SQL file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/supabase/migrations/20260423_init.sql'];
    assert.deepEqual(detect(files), ['/project/supabase/migrations/20260423_init.sql']);
  });

  it('matches prisma/schema.prisma', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/prisma/schema.prisma'];
    assert.deepEqual(detect(files), ['/project/prisma/schema.prisma']);
  });

  it('matches prisma/migrations SQL', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/prisma/migrations/20260423_add_col.sql'];
    assert.deepEqual(detect(files), ['/project/prisma/migrations/20260423_add_col.sql']);
  });

  it('matches db/migrate Rails file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/db/migrate/20260423_add_status.rb'];
    assert.deepEqual(detect(files), ['/project/db/migrate/20260423_add_status.rb']);
  });

  it('does not match non-migration ts file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/app/api/users/route.ts'];
    assert.deepEqual(detect(files), []);
  });

  it('returns empty when enabled:false', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/data/deltas/20260423_add_status.sql'];
    assert.deepEqual(detect(files, { enabled: false }), []);
  });

  it('appends config migrationGlobs to auto-detected set', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/custom/schema/v1.sql'];
    assert.deepEqual(
      detect(files, { migrationGlobs: ['custom/schema/**/*.sql'] }),
      ['/project/custom/schema/v1.sql'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test-runner.mjs tests/schema-alignment-detector.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement detector.ts**

```typescript
// src/core/schema-alignment/detector.ts
import type { SchemaAlignmentConfig } from './types.ts';

const DEFAULT_PATTERNS: RegExp[] = [
  /data[/\\]deltas[/\\].+\.sql$/,
  /supabase[/\\]migrations[/\\].+\.sql$/,
  /prisma[/\\]migrations[/\\].+\.sql$/,
  /prisma[/\\]schema\.prisma$/,
  /db[/\\]migrate[/\\].+\.rb$/,
  /drizzle[/\\].+\.ts$/,
  /[/\\]migrations[/\\].+\.py$/,
];

function globToPattern(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\\/g, '[/\\\\]')
    .replace(/\//g, '[/\\\\]')
    .replace(/\*\*/g, '___DSTAR___')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/___DSTAR___/g, '.*');
  return new RegExp(escaped + '$');
}

export function detect(touchedFiles: string[], config?: SchemaAlignmentConfig): string[] {
  if (config?.enabled === false) return [];

  const patterns = [...DEFAULT_PATTERNS];
  for (const glob of config?.migrationGlobs ?? []) {
    patterns.push(globToPattern(glob));
  }

  return touchedFiles.filter(f => patterns.some(re => re.test(f)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-detector.test.ts 2>&1 | tail -5
```

Expected: 8 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/schema-alignment/detector.ts tests/schema-alignment-detector.test.ts
git commit -m "feat(schema-alignment): detector with auto-detect + config override"
```

---

### Task 3: SQL Extractor

**Files:**
- Create: `src/core/schema-alignment/extractor/sql.ts`
- Test: `tests/schema-alignment-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema-alignment-extractor.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('extractFromSql', () => {
  it('extracts CREATE TABLE', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'CREATE TABLE users (id uuid PRIMARY KEY);';
    const entities = extractFromSql(sql);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.table, 'users');
    assert.equal(entities[0]!.operation, 'create_table');
  });

  it('extracts CREATE TABLE IF NOT EXISTS with schema prefix', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'CREATE TABLE IF NOT EXISTS public.orders (id uuid);';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.table, 'orders');
    assert.equal(entities[0]!.operation, 'create_table');
  });

  it('extracts ALTER TABLE ADD COLUMN', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users ADD COLUMN status text;';
    const entities = extractFromSql(sql);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.table, 'users');
    assert.equal(entities[0]!.column, 'status');
    assert.equal(entities[0]!.operation, 'add_column');
  });

  it('extracts ADD COLUMN IF NOT EXISTS', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users ADD COLUMN IF NOT EXISTS status text;';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.column, 'status');
    assert.equal(entities[0]!.operation, 'add_column');
  });

  it('extracts ALTER TABLE DROP COLUMN', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users DROP COLUMN legacy_field;';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.column, 'legacy_field');
    assert.equal(entities[0]!.operation, 'drop_column');
  });

  it('extracts ALTER TABLE RENAME COLUMN', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users RENAME COLUMN old_name TO new_name;';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.column, 'new_name');
    assert.equal(entities[0]!.oldName, 'old_name');
    assert.equal(entities[0]!.operation, 'rename_column');
  });

  it('extracts CREATE TYPE', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = "CREATE TYPE status_enum AS ENUM ('active', 'inactive');";
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.table, 'status_enum');
    assert.equal(entities[0]!.operation, 'create_type');
  });

  it('handles quoted identifiers', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE "my_table" ADD COLUMN "my_col" text;';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.table, 'my_table');
    assert.equal(entities[0]!.column, 'my_col');
  });

  it('ignores SQL comments', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = '-- CREATE TABLE ignored\nALTER TABLE users ADD COLUMN status text;';
    const entities = extractFromSql(sql);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.column, 'status');
  });

  it('handles multi-statement file', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = `
      ALTER TABLE users ADD COLUMN status text;
      ALTER TABLE orders DROP COLUMN legacy_id;
    `;
    const entities = extractFromSql(sql);
    assert.equal(entities.length, 2);
    assert.equal(entities[0]!.operation, 'add_column');
    assert.equal(entities[1]!.operation, 'drop_column');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test-runner.mjs tests/schema-alignment-extractor.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement extractor/sql.ts**

```typescript
// src/core/schema-alignment/extractor/sql.ts
import type { SchemaEntity } from '../types.ts';

function unquote(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/^["'`]|["'`]$/g, '');
}

// Identifier: quoted or unquoted word (no schema prefix captured)
const ID = /(?:"([^"]+)"|`([^`]+)`|(\w+))/;
const SCHEMA_OPT = /(?:\w+\.)?/;

export function extractFromSql(content: string): SchemaEntity[] {
  // Strip comments before processing
  const normalized = content
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ');

  const entities: SchemaEntity[] = [];

  // CREATE TABLE [IF NOT EXISTS] [schema.]name
  const createTableRe = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SCHEMA_OPT.source}${ID.source}`,
    'gi',
  );
  for (const m of normalized.matchAll(createTableRe)) {
    const table = unquote(m[1] ?? m[2] ?? m[3]);
    if (table && table.toUpperCase() !== 'EXISTS') entities.push({ table, operation: 'create_table' });
  }

  // ALTER TABLE [schema.]name ADD [COLUMN] [IF NOT EXISTS] col
  const addColRe = new RegExp(
    `ALTER\\s+TABLE\\s+${SCHEMA_OPT.source}${ID.source}\\s+ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID.source}`,
    'gi',
  );
  for (const m of normalized.matchAll(addColRe)) {
    const table = unquote(m[1] ?? m[2] ?? m[3]);
    const column = unquote(m[4] ?? m[5] ?? m[6]);
    if (table && column) entities.push({ table, column, operation: 'add_column' });
  }

  // ALTER TABLE [schema.]name DROP [COLUMN] [IF EXISTS] col
  const dropColRe = new RegExp(
    `ALTER\\s+TABLE\\s+${SCHEMA_OPT.source}${ID.source}\\s+DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${ID.source}`,
    'gi',
  );
  for (const m of normalized.matchAll(dropColRe)) {
    const table = unquote(m[1] ?? m[2] ?? m[3]);
    const column = unquote(m[4] ?? m[5] ?? m[6]);
    if (table && column) entities.push({ table, column, operation: 'drop_column' });
  }

  // ALTER TABLE [schema.]name RENAME [COLUMN] old TO new
  const renameColRe = new RegExp(
    `ALTER\\s+TABLE\\s+${SCHEMA_OPT.source}${ID.source}\\s+RENAME\\s+(?:COLUMN\\s+)?${ID.source}\\s+TO\\s+${ID.source}`,
    'gi',
  );
  for (const m of normalized.matchAll(renameColRe)) {
    const table = unquote(m[1] ?? m[2] ?? m[3]);
    const oldName = unquote(m[4] ?? m[5] ?? m[6]);
    const column = unquote(m[7] ?? m[8] ?? m[9]);
    if (table && column) entities.push({ table, column, operation: 'rename_column', oldName });
  }

  // CREATE TYPE [schema.]name
  const createTypeRe = new RegExp(
    `CREATE\\s+TYPE\\s+${SCHEMA_OPT.source}${ID.source}`,
    'gi',
  );
  for (const m of normalized.matchAll(createTypeRe)) {
    const table = unquote(m[1] ?? m[2] ?? m[3]);
    if (table) entities.push({ table, operation: 'create_type' });
  }

  return entities;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-extractor.test.ts 2>&1 | tail -5
```

Expected: 10 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/schema-alignment/extractor/sql.ts tests/schema-alignment-extractor.test.ts
git commit -m "feat(schema-alignment): SQL tokenizer extractor"
```

---

### Task 4: Prisma Extractor + Index

**Files:**
- Create: `src/core/schema-alignment/extractor/prisma.ts`
- Create: `src/core/schema-alignment/extractor/index.ts`
- Modify: `tests/schema-alignment-extractor.test.ts` (append tests)

- [ ] **Step 1: Append tests to the existing extractor test file**

First, add these imports to the **top** of `tests/schema-alignment-extractor.test.ts` (after the existing two import lines):

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
```

Then append these describe blocks to the bottom of the file:

```typescript
describe('extractFromPrisma', () => {
  it('extracts model name as create_table and fields as add_column', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const content = `
model User {
  id    String @id
  email String
  name  String?
}
`;
    const entities = extractFromPrisma(content);
    const tableEntity = entities.find(e => e.operation === 'create_table');
    assert.ok(tableEntity, 'expected create_table entity');
    assert.equal(tableEntity!.table, 'User');
    const cols = entities.filter(e => e.operation === 'add_column');
    const names = cols.map(c => c.column);
    assert.ok(names.includes('email'), `expected email in ${names.join(',')}`);
    assert.ok(names.includes('name'), `expected name in ${names.join(',')}`);
  });

  it('handles multiple models', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const content = `
model User { id String @id \n  email String }
model Order { id String @id \n  total Float }
`;
    const entities = extractFromPrisma(content);
    const tables = entities.filter(e => e.operation === 'create_table').map(e => e.table);
    assert.ok(tables.includes('User'));
    assert.ok(tables.includes('Order'));
  });
});

describe('extractor index', () => {
  it('dispatches .sql files to sql extractor', async () => {
    const { extract } = await import('../src/core/schema-alignment/extractor/index.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sa-'));
    const file = path.join(dir, 'migration.sql');
    fs.writeFileSync(file, 'ALTER TABLE users ADD COLUMN status text;');
    const entities = extract(file);
    assert.equal(entities[0]!.operation, 'add_column');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns [] for unsupported extension and logs to stderr', async () => {
    const { extract } = await import('../src/core/schema-alignment/extractor/index.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sa-'));
    const file = path.join(dir, 'migration.rb');
    fs.writeFileSync(file, '# rails migration');
    const entities = extract(file);
    assert.deepEqual(entities, []);
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify new tests fail**

```bash
node scripts/test-runner.mjs tests/schema-alignment-extractor.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module" for prisma.ts and index.ts

- [ ] **Step 3: Implement extractor/prisma.ts**

```typescript
// src/core/schema-alignment/extractor/prisma.ts
import type { SchemaEntity } from '../types.ts';

export function extractFromPrisma(content: string): SchemaEntity[] {
  const entities: SchemaEntity[] = [];
  // Match model blocks: model Name { ... }
  const modelRe = /^model\s+(\w+)\s*\{([^}]+)\}/gm;
  for (const modelMatch of content.matchAll(modelRe)) {
    const table = modelMatch[1]!;
    entities.push({ table, operation: 'create_table' });
    const body = modelMatch[2]!;
    // Match field lines: fieldName TypeName ...
    const fieldRe = /^\s+(\w+)\s+\S/gm;
    for (const fieldMatch of body.matchAll(fieldRe)) {
      const column = fieldMatch[1]!;
      if (column.startsWith('@') || column === 'id') continue;
      entities.push({ table, column, operation: 'add_column' });
    }
  }
  return entities;
}
```

- [ ] **Step 4: Implement extractor/index.ts**

```typescript
// src/core/schema-alignment/extractor/index.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaEntity } from '../types.ts';
import { extractFromSql } from './sql.ts';
import { extractFromPrisma } from './prisma.ts';

export function extract(filePath: string): SchemaEntity[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (ext === '.sql') return extractFromSql(content);
  if (base === 'schema.prisma' || ext === '.prisma') return extractFromPrisma(content);

  process.stderr.write(`[schema-alignment] no extractor for ${ext} files — skipping ${path.basename(filePath)}\n`);
  return [];
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-extractor.test.ts 2>&1 | tail -5
```

Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add src/core/schema-alignment/extractor/prisma.ts src/core/schema-alignment/extractor/index.ts tests/schema-alignment-extractor.test.ts
git commit -m "feat(schema-alignment): prisma extractor and dispatch index"
```

---

### Task 5: Scanner

**Files:**
- Create: `src/core/schema-alignment/scanner.ts`
- Test: `tests/schema-alignment-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema-alignment-scanner.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scanner-'));
  fs.mkdirSync(path.join(dir, 'types'));
  fs.mkdirSync(path.join(dir, 'app', 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app', 'components'), { recursive: true });
  return dir;
}

describe('scanLayers', () => {
  it('finds evidence in type layer when column name present', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { status: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected type layer evidence');
    assert.ok(results[0]!.typeLayer!.file.includes('user.ts'));
    fs.rmSync(dir, { recursive: true });
  });

  it('returns null for missing layer', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    // types dir exists but no file references 'status'
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { id: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
    );
    assert.equal(results[0]!.typeLayer, null, 'expected null for missing type');
    fs.rmSync(dir, { recursive: true });
  });

  it('drop_column: finds evidence of OLD name as a gap', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { legacy_field: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'legacy_field', operation: 'drop_column' }],
      dir,
    );
    // For drop_column: finding OLD name in type layer = stale reference = evidence present
    assert.ok(results[0]!.typeLayer !== null, 'expected stale ref evidence for drop_column');
    fs.rmSync(dir, { recursive: true });
  });

  it('rename_column: searches for oldName', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { old_name: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'new_name', operation: 'rename_column', oldName: 'old_name' }],
      dir,
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected stale old_name evidence');
    fs.rmSync(dir, { recursive: true });
  });

  it('respects layerRoots config override', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.mkdirSync(path.join(dir, 'custom', 'types'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'custom', 'types', 'user.ts'), 'export type User = { status: string };');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
      { layerRoots: { types: ['custom/types/'] } },
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected evidence in custom type dir');
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test-runner.mjs tests/schema-alignment-scanner.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement scanner.ts**

```typescript
// src/core/schema-alignment/scanner.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaEntity, Evidence, LayerScanResult, SchemaAlignmentConfig } from './types.ts';

const DEFAULT_ROOTS = {
  types: ['types/', 'src/types/', 'lib/types/'],
  api: ['app/api/', 'lib/', 'services/', 'src/routes/'],
  ui: ['app/', 'src/', 'components/'],
};

function* walkFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

function searchLayer(roots: string[], pattern: RegExp, cwd: string): Evidence | null {
  for (const root of roots) {
    const dir = path.isAbsolute(root) ? root : path.join(cwd, root);
    for (const filePath of walkFiles(dir)) {
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i]!)) {
          return {
            file: filePath,
            line: i + 1,
            snippet: lines[i]!.trim().slice(0, 120),
            confidence: 'high',
          };
        }
      }
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanLayers(
  entities: SchemaEntity[],
  cwd: string,
  config?: SchemaAlignmentConfig,
): LayerScanResult[] {
  const roots = {
    types: config?.layerRoots?.types ?? DEFAULT_ROOTS.types,
    api: config?.layerRoots?.api ?? DEFAULT_ROOTS.api,
    ui: config?.layerRoots?.ui ?? DEFAULT_ROOTS.ui,
  };

  return entities.map(entity => {
    const isDestructive = entity.operation === 'drop_column' || entity.operation === 'rename_column';
    // For destructive: search for the old/dropped name (finding it = stale reference)
    // For add/create: search for the new name (not finding it = missing update)
    const searchName = isDestructive
      ? (entity.oldName ?? entity.column ?? entity.table)
      : (entity.column ?? entity.table);

    const pattern = new RegExp(`\\b${escapeRe(searchName)}\\b`);

    return {
      entity,
      typeLayer: searchLayer(roots.types, pattern, cwd),
      apiLayer: searchLayer(roots.api, pattern, cwd),
      uiLayer: searchLayer(roots.ui, pattern, cwd),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-scanner.test.ts 2>&1 | tail -5
```

Expected: 5 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/schema-alignment/scanner.ts tests/schema-alignment-scanner.test.ts
git commit -m "feat(schema-alignment): layer scanner with recursive file walk"
```

---

### Task 6: LLM Check

**Files:**
- Create: `src/core/schema-alignment/llm-check.ts`
- Test: `tests/schema-alignment-llm-check.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema-alignment-llm-check.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../src/adapters/review-engine/types.ts';

function makeMockEngine(jsonResponse: string): ReviewEngine {
  return {
    label: 'mock',
    review: async (_input: ReviewInput): Promise<ReviewOutput> => ({
      findings: [],
      rawOutput: jsonResponse,
    }),
    estimateTokens: (s: string) => Math.ceil(s.length / 4),
  } as unknown as ReviewEngine;
}

describe('runLlmCheck', () => {
  it('returns findings from engine JSON response', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'migration.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN status text;');

    const gapResults = [{
      entity: { table: 'users', column: 'status', operation: 'add_column' as const },
      typeLayer: null,
      apiLayer: null,
      uiLayer: null,
    }];

    const mockJson = JSON.stringify([{
      table: 'users',
      column: 'status',
      operation: 'add_column',
      layer: 'type',
      message: 'status field missing from User type',
      severity: 'warning',
      confidence: 'high',
    }]);

    const engine = makeMockEngine(mockJson);
    const findings = await runLlmCheck([migFile], gapResults, engine);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.layer, 'type');
    assert.equal(findings[0]!.entity.column, 'status');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns [] when engine returns non-JSON output', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'migration.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN x text;');
    const engine = makeMockEngine('No issues found.');
    const findings = await runLlmCheck([migFile], [], engine);
    assert.deepEqual(findings, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns [] when engine throws', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const engine = {
      label: 'mock',
      review: async () => { throw new Error('network error'); },
      estimateTokens: () => 0,
    } as unknown as ReviewEngine;
    const findings = await runLlmCheck([], [], engine);
    assert.deepEqual(findings, []);
  });

  it('truncates migration content to respect 6000 char budget', async () => {
    const { runLlmCheck } = await import('../src/core/schema-alignment/llm-check.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-llm-'));
    const migFile = path.join(dir, 'big.sql');
    // Write a migration larger than the budget
    fs.writeFileSync(migFile, 'x'.repeat(10000));
    let capturedContent = '';
    const engine = {
      label: 'mock',
      review: async (input: ReviewInput): Promise<ReviewOutput> => {
        capturedContent = input.content;
        return { findings: [], rawOutput: '[]' };
      },
      estimateTokens: (s: string) => Math.ceil(s.length / 4),
    } as unknown as ReviewEngine;
    await runLlmCheck([migFile], [], engine);
    assert.ok(capturedContent.length <= 7000, `content too large: ${capturedContent.length}`);
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test-runner.mjs tests/schema-alignment-llm-check.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement llm-check.ts**

```typescript
// src/core/schema-alignment/llm-check.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';
import type { SchemaEntity, LayerScanResult, AlignmentFinding } from './types.ts';

const TOTAL_CHAR_BUDGET = 6000;

function truncateTop(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `<!-- [schema-alignment: truncated ${dropped} chars] -->\n` + text.slice(dropped);
}

export async function runLlmCheck(
  migrationFiles: string[],
  gapResults: LayerScanResult[],
  engine: ReviewEngine,
): Promise<AlignmentFinding[]> {
  let budget = TOTAL_CHAR_BUDGET;
  const migrationSnippets: string[] = [];

  for (const f of migrationFiles) {
    if (budget <= 0) break;
    let content: string;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const snippet = truncateTop(content, Math.floor(budget * 0.6));
    migrationSnippets.push(`### Migration: ${path.basename(f)}\n\`\`\`sql\n${snippet}\n\`\`\``);
    budget -= snippet.length;
  }

  const entitySummary = gapResults.map(r => {
    const isDestructive = r.entity.operation === 'drop_column' || r.entity.operation === 'rename_column';
    const gaps = isDestructive
      ? [r.typeLayer, r.apiLayer, r.uiLayer]
          .map((e, i) => e !== null ? (['type', 'api', 'ui'][i]) : null)
          .filter(Boolean).join(', ')
      : [r.typeLayer === null ? 'type' : null, r.apiLayer === null ? 'api' : null, r.uiLayer === null ? 'ui' : null]
          .filter(Boolean).join(', ');
    return `- ${r.entity.operation} ${r.entity.table}${r.entity.column ? '.' + r.entity.column : ''}: ${isDestructive ? 'stale ref in' : 'missing in'} [${gaps}]`;
  }).join('\n');

  const prompt = [
    'You are reviewing schema-layer alignment for a software project.',
    '',
    migrationSnippets.length > 0
      ? `The following migration files were changed:\n\n${migrationSnippets.join('\n\n')}`
      : '(no readable migration files)',
    '',
    `The structural scan found these potential alignment gaps:\n${entitySummary || '(none)'}`,
    '',
    'For each gap, determine if it is a real problem. Return findings as a JSON array:',
    '[{ "table": "name", "column": "name_or_null", "operation": "add_column", "layer": "type", "message": "explanation", "severity": "warning", "confidence": "high" }]',
    'Return only valid JSON, no prose.',
  ].join('\n');

  let rawOutput: string;
  try {
    const result = await engine.review({ content: prompt, kind: 'file-batch' });
    rawOutput = result.rawOutput;
  } catch {
    return [];
  }

  const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      table: string; column?: string; operation: string;
      layer: string; message: string; severity: string; confidence: string;
    }>;
    return parsed
      .filter(item => item.table && item.layer && item.message)
      .map(item => ({
        entity: {
          table: item.table,
          column: item.column,
          operation: item.operation as SchemaEntity['operation'],
        },
        layer: item.layer as AlignmentFinding['layer'],
        message: item.message,
        severity: (item.severity === 'error' ? 'error' : 'warning') as AlignmentFinding['severity'],
        confidence: (['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium') as AlignmentFinding['confidence'],
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-llm-check.test.ts 2>&1 | tail -5
```

Expected: 4 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/schema-alignment/llm-check.ts tests/schema-alignment-llm-check.test.ts
git commit -m "feat(schema-alignment): LLM check with budget truncation"
```

---

### Task 7: Rule Orchestrator + Wire-Up

**Files:**
- Create: `src/core/static-rules/rules/schema-alignment.ts`
- Modify: `src/core/static-rules/registry.ts` (add entry)
- Modify: `src/core/config/types.ts` (add `schemaAlignment?` field)
- Modify: `src/core/config/schema.ts` (add JSON schema block)
- Modify: `src/core/phases/static-rules.ts` (thread config + engine)
- Modify: `src/core/pipeline/run.ts` (pass config + engine to phase)
- Test: `tests/schema-alignment-rule.test.ts`

- [ ] **Step 1: Write the failing rule test**

```typescript
// tests/schema-alignment-rule.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('schema-alignment rule', () => {
  it('returns [] when no migration files are touched', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const findings = await schemaAlignmentRule.check(['/project/app/api/users/route.ts']);
    assert.deepEqual(findings, []);
  });

  it('returns structural findings when migration touched and column missing from type layer', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rule-'));
    fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'types'));
    fs.writeFileSync(
      path.join(dir, 'data', 'deltas', '20260423_add_status.sql'),
      'ALTER TABLE users ADD COLUMN status text;',
    );
    // types dir exists but no 'status' reference
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { id: string; }');

    const migFile = path.join(dir, 'data', 'deltas', '20260423_add_status.sql');
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding');
      assert.ok(findings.some(f => f.category === 'schema-alignment'));
    } finally {
      process.chdir(origCwd);
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns [] when enabled:false in config', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-rule-'));
    fs.mkdirSync(path.join(dir, 'data', 'deltas'), { recursive: true });
    const migFile = path.join(dir, 'data', 'deltas', '20260423_add_status.sql');
    fs.writeFileSync(migFile, 'ALTER TABLE users ADD COLUMN status text;');
    const findings = await schemaAlignmentRule.check([migFile], { 'schema-alignment': { enabled: false } });
    assert.deepEqual(findings, []);
    fs.rmSync(dir, { recursive: true });
  });

  it('is registered in the rule registry', async () => {
    const { listAvailableRules } = await import('../src/core/static-rules/registry.ts');
    assert.ok(listAvailableRules().includes('schema-alignment'), 'schema-alignment not in registry');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node scripts/test-runner.mjs tests/schema-alignment-rule.test.ts 2>&1 | tail -5
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Create the rule orchestrator**

```typescript
// src/core/static-rules/rules/schema-alignment.ts
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';
import type { SchemaAlignmentConfig, LayerScanResult, AlignmentFinding } from '../../schema-alignment/types.ts';
import type { ReviewEngine } from '../../../adapters/review-engine/types.ts';
import { detect } from '../../schema-alignment/detector.ts';
import { extract } from '../../schema-alignment/extractor/index.ts';
import { scanLayers } from '../../schema-alignment/scanner.ts';
import { runLlmCheck } from '../../schema-alignment/llm-check.ts';

function isDestructive(entity: { operation: string }): boolean {
  return entity.operation === 'drop_column' || entity.operation === 'rename_column';
}

function toFinding(af: AlignmentFinding): Finding {
  return {
    id: `schema-alignment:${af.entity.table}:${af.entity.column ?? ''}:${af.layer}`,
    source: 'static-rules',
    severity: af.severity === 'error' ? 'critical' : 'warning',
    category: 'schema-alignment',
    file: af.file ?? af.entity.table,
    message: af.message,
    suggestion: `Update the ${af.layer} layer to reflect the schema change in "${af.entity.column ?? af.entity.table}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

function structuralFinding(result: LayerScanResult, layer: 'type' | 'api' | 'ui', defaultSev: 'warning' | 'error'): Finding {
  const destructive = isDestructive(result.entity);
  const name = result.entity.column ?? result.entity.table;
  const message = destructive
    ? `Stale reference to dropped/renamed "${name}" still present in ${layer} layer after schema change`
    : `No reference to "${name}" found in ${layer} layer — update may be missing after schema change`;
  const severity: Finding['severity'] = destructive ? 'critical' : (defaultSev === 'error' ? 'critical' : 'warning');
  return {
    id: `schema-alignment:${result.entity.table}:${result.entity.column ?? ''}:${layer}`,
    source: 'static-rules',
    severity,
    category: 'schema-alignment',
    file: result.entity.table,
    message,
    suggestion: `Check the ${layer} layer for references to "${name}"`,
    protectedPath: false,
    createdAt: new Date().toISOString(),
  };
}

export const schemaAlignmentRule: StaticRule = {
  name: 'schema-alignment',
  severity: 'warning',

  async check(touchedFiles: string[], config: Record<string, unknown> = {}): Promise<Finding[]> {
    const saConfig = config['schema-alignment'] as SchemaAlignmentConfig | undefined;
    if (saConfig?.enabled === false) return [];

    const cwd = process.cwd();
    const migrationFiles = detect(touchedFiles, saConfig);
    if (migrationFiles.length === 0) return [];

    const allEntities = migrationFiles.flatMap(f => extract(f));
    if (allEntities.length === 0) return [];

    const scanResults = scanLayers(allEntities, cwd, saConfig);

    // For destructive ops: gap = evidence WAS found (stale ref remains)
    // For add/create: gap = evidence NOT found (layer not updated)
    const gapResults = scanResults.filter(r => {
      if (isDestructive(r.entity)) return r.typeLayer !== null || r.apiLayer !== null || r.uiLayer !== null;
      return r.typeLayer === null || r.apiLayer === null || r.uiLayer === null;
    });

    if (gapResults.length === 0) return [];

    const defaultSev = saConfig?.severity ?? 'warning';
    const llmEnabled = saConfig?.llmCheck !== false;
    const engine = config['_engine'] as ReviewEngine | undefined;

    if (llmEnabled && engine) {
      const llmFindings = await runLlmCheck(migrationFiles, gapResults, engine);
      return llmFindings.map(toFinding);
    }

    // Structural mode
    const findings: Finding[] = [];
    for (const r of gapResults) {
      if (isDestructive(r.entity)) {
        if (r.typeLayer) findings.push(structuralFinding(r, 'type', defaultSev));
        if (r.apiLayer) findings.push(structuralFinding(r, 'api', defaultSev));
        if (r.uiLayer) findings.push(structuralFinding(r, 'ui', defaultSev));
      } else {
        if (!r.typeLayer) findings.push(structuralFinding(r, 'type', defaultSev));
        if (!r.apiLayer) findings.push(structuralFinding(r, 'api', defaultSev));
        if (!r.uiLayer) findings.push(structuralFinding(r, 'ui', defaultSev));
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Register rule in registry.ts**

In `src/core/static-rules/registry.ts`, add to the `BUILTIN` object (after `'brand-tokens'`):

```typescript
  'schema-alignment': () => import('./rules/schema-alignment.ts').then(m => m.schemaAlignmentRule),
```

- [ ] **Step 5: Add SchemaAlignmentConfig to GuardrailConfig in types.ts**

In `src/core/config/types.ts`, add import and field:

```typescript
import type { SchemaAlignmentConfig } from '../schema-alignment/types.ts';
```

And add to `GuardrailConfig` interface (after `brand?`):

```typescript
  schemaAlignment?: SchemaAlignmentConfig;
```

- [ ] **Step 6: Add JSON schema block to schema.ts**

In `src/core/config/schema.ts`, add to `properties` (after the `brand` block, before `cache`):

```typescript
    'schema-alignment': {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        migrationGlobs: { type: 'array', items: { type: 'string', minLength: 1 } },
        layerRoots: {
          type: 'object',
          properties: {
            types: { type: 'array', items: { type: 'string' }, minItems: 1 },
            api: { type: 'array', items: { type: 'string' }, minItems: 1 },
            ui: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          additionalProperties: false,
        },
        llmCheck: { type: 'boolean' },
        severity: { enum: ['warning', 'error'] },
      },
      additionalProperties: false,
    },
```

- [ ] **Step 7: Thread config through static-rules phase**

In `src/core/phases/static-rules.ts`:

Update `StaticRulesPhaseInput` to include config and engine:

```typescript
import type { GuardrailConfig } from '../config/types.ts';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';

export interface StaticRulesPhaseInput {
  touchedFiles: string[];
  rules: StaticRule[];
  config?: GuardrailConfig;
  engine?: ReviewEngine;
}
```

Update `runAllChecks` signature and call:

```typescript
async function runAllChecks(
  rules: StaticRule[],
  files: string[],
  config?: GuardrailConfig,
  engine?: ReviewEngine,
): Promise<Finding[]> {
  const ruleConfig: Record<string, unknown> = config ? { ...config as unknown as Record<string, unknown>, _engine: engine } : {};
  const all: Finding[] = [];
  for (const rule of rules) all.push(...(await rule.check(files, ruleConfig)));
  return all;
}
```

Update both calls in `runStaticRulesPhase` to pass config and engine:

```typescript
const preFixFindings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles, input.config, input.engine));
// ...
const postFixFindings = anyFixApplied
  ? dedupFindings(await runAllChecks(input.rules, input.touchedFiles, input.config, input.engine))
  : preFixFindings;
```

- [ ] **Step 8: Pass config and engine from run.ts**

In `src/core/pipeline/run.ts`, update the `runStaticRulesPhase` call:

```typescript
const result = await runStaticRulesPhase({
  touchedFiles: input.touchedFiles,
  rules: input.staticRules,
  config: input.config,
  engine: input.reviewEngine,
});
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
node scripts/test-runner.mjs tests/schema-alignment-rule.test.ts 2>&1 | tail -5
```

Expected: 4 passing, 0 failing

- [ ] **Step 10: Run the full test suite to confirm no regressions**

```bash
node scripts/test-runner.mjs 2>&1 | tail -10
```

Expected: all existing tests still passing

- [ ] **Step 11: Commit**

```bash
git add \
  src/core/static-rules/rules/schema-alignment.ts \
  src/core/static-rules/registry.ts \
  src/core/config/types.ts \
  src/core/config/schema.ts \
  src/core/phases/static-rules.ts \
  src/core/pipeline/run.ts \
  tests/schema-alignment-rule.test.ts
git commit -m "feat(schema-alignment): rule orchestrator, registry, config schema, threaded config"
```

---

### Task 8: Integration Snapshot Tests

**Files:**
- Create: `tests/fixtures/schema-alignment/supabase-add-col/` (fixture directory tree)
- Create: `tests/fixtures/schema-alignment/prisma-rename-col/` (fixture directory tree)
- Create: `tests/fixtures/schema-alignment/clean/` (fixture directory tree)
- Test: `tests/schema-alignment-integration.test.ts`

- [ ] **Step 1: Create the Supabase add-col fixture**

```bash
mkdir -p tests/fixtures/schema-alignment/supabase-add-col/data/deltas
mkdir -p tests/fixtures/schema-alignment/supabase-add-col/types
mkdir -p tests/fixtures/schema-alignment/supabase-add-col/app/api/users
```

`tests/fixtures/schema-alignment/supabase-add-col/data/deltas/20260423_add_status.sql`:
```sql
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active';
```

`tests/fixtures/schema-alignment/supabase-add-col/types/user.ts`:
```typescript
export interface User {
  id: string;
  email: string;
  // status intentionally missing
}
```

`tests/fixtures/schema-alignment/supabase-add-col/app/api/users/route.ts`:
```typescript
export async function GET() {
  return Response.json({ users: [] });
}
```

- [ ] **Step 2: Create the Prisma rename-col fixture**

```bash
mkdir -p tests/fixtures/schema-alignment/prisma-rename-col/prisma/migrations
mkdir -p tests/fixtures/schema-alignment/prisma-rename-col/types
mkdir -p tests/fixtures/schema-alignment/prisma-rename-col/app/api
```

`tests/fixtures/schema-alignment/prisma-rename-col/prisma/migrations/20260423_rename.sql`:
```sql
ALTER TABLE orders RENAME COLUMN old_total TO total_amount;
```

`tests/fixtures/schema-alignment/prisma-rename-col/types/order.ts`:
```typescript
export interface Order {
  id: string;
  old_total: number; // stale — should be total_amount
}
```

- [ ] **Step 3: Create the clean fixture**

```bash
mkdir -p tests/fixtures/schema-alignment/clean/data/deltas
mkdir -p tests/fixtures/schema-alignment/clean/types
mkdir -p tests/fixtures/schema-alignment/clean/app/api/users
mkdir -p tests/fixtures/schema-alignment/clean/app/components
```

`tests/fixtures/schema-alignment/clean/data/deltas/20260423_add_status.sql`:
```sql
ALTER TABLE users ADD COLUMN status text;
```

`tests/fixtures/schema-alignment/clean/types/user.ts`:
```typescript
export interface User { id: string; status: string; }
```

`tests/fixtures/schema-alignment/clean/app/api/users/route.ts`:
```typescript
// query users by status
export async function GET() { return Response.json({ status: 'ok' }); }
```

`tests/fixtures/schema-alignment/clean/app/components/UserCard.tsx`:
```typescript
export function UserCard({ status }: { status: string }) { return <div>{status}</div>; }
```

- [ ] **Step 4: Write the integration test**

```typescript
// tests/schema-alignment-integration.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'schema-alignment');

describe('schema-alignment integration', () => {
  it('supabase-add-col: emits findings for missing type layer', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'supabase-add-col');
    const migFile = path.join(fixtureDir, 'data', 'deltas', '20260423_add_status.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding');
      const typeFindings = findings.filter(f => f.message.includes('type'));
      assert.ok(typeFindings.length > 0, `expected type-layer finding, got: ${findings.map(f => f.message).join(', ')}`);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('prisma-rename-col: emits error finding for stale type reference', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'prisma-rename-col');
    const migFile = path.join(fixtureDir, 'prisma', 'migrations', '20260423_rename.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.ok(findings.length > 0, 'expected at least one finding for stale ref');
      assert.ok(
        findings.some(f => f.severity === 'critical'),
        `expected critical finding for rename, got: ${findings.map(f => f.severity + ':' + f.message).join('; ')}`,
      );
    } finally {
      process.chdir(origCwd);
    }
  });

  it('clean: returns [] when all layers reference the new column', async () => {
    const { schemaAlignmentRule } = await import('../src/core/static-rules/rules/schema-alignment.ts');
    const fixtureDir = path.join(FIXTURES, 'clean');
    const migFile = path.join(fixtureDir, 'data', 'deltas', '20260423_add_status.sql');

    const origCwd = process.cwd();
    process.chdir(fixtureDir);
    try {
      const findings = await schemaAlignmentRule.check([migFile]);
      assert.deepEqual(findings, [], `expected no findings, got: ${findings.map(f => f.message).join(', ')}`);
    } finally {
      process.chdir(origCwd);
    }
  });
});
```

- [ ] **Step 5: Run integration tests**

```bash
node scripts/test-runner.mjs tests/schema-alignment-integration.test.ts 2>&1 | tail -10
```

Expected: 3 passing, 0 failing

- [ ] **Step 6: Run the full test suite**

```bash
node scripts/test-runner.mjs 2>&1 | tail -10
```

Expected: all tests passing

- [ ] **Step 7: Commit everything**

```bash
git add \
  tests/fixtures/schema-alignment/ \
  tests/schema-alignment-integration.test.ts
git commit -m "test(schema-alignment): integration snapshot tests with fixture workspaces"
```
