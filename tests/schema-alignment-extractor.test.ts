// tests/schema-alignment-extractor.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

describe('extractFromSql — additional coverage', () => {
  it('handles ALTER TABLE ONLY variant', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE ONLY users ADD COLUMN status text;';
    const entities = extractFromSql(sql);
    assert.equal(entities[0]!.table, 'users');
    assert.equal(entities[0]!.column, 'status');
    assert.equal(entities[0]!.operation, 'add_column');
  });

  it('extracts ALTER TYPE ADD VALUE', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = "ALTER TYPE status_enum ADD VALUE 'archived';";
    const entities = extractFromSql(sql);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.table, 'status_enum');
    assert.equal(entities[0]!.operation, 'create_type');
  });

  it('does NOT emit phantom column for ADD CONSTRAINT', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users ADD CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id);';
    const entities = extractFromSql(sql);
    const cols = entities.filter(e => e.operation === 'add_column');
    assert.equal(cols.length, 0, `expected no add_column entities, got: ${JSON.stringify(cols)}`);
  });

  it('does NOT emit phantom column for DROP CONSTRAINT/INDEX', async () => {
    const { extractFromSql } = await import('../src/core/schema-alignment/extractor/sql.ts');
    const sql = 'ALTER TABLE users DROP CONSTRAINT fk_account; ALTER TABLE users DROP INDEX idx_email;';
    const entities = extractFromSql(sql);
    const drops = entities.filter(e => e.operation === 'drop_column');
    assert.equal(drops.length, 0, `expected no drop_column entities, got: ${JSON.stringify(drops)}`);
  });
});

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

  it('with previousContent identical to current emits no entities', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const content = `
model User {
  id    String @id
  email String
  name  String?
}
`;
    const entities = extractFromPrisma(content, content);
    assert.deepEqual(entities, [], `expected zero entities for unchanged schema, got: ${JSON.stringify(entities)}`);
  });

  it('with previousContent missing a field emits add_column for that field only', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const previous = `
model User {
  id    String @id
  email String
}
`;
    const current = `
model User {
  id     String @id
  email  String
  status String
}
`;
    const entities = extractFromPrisma(current, previous);
    assert.equal(entities.length, 1, `expected exactly one entity, got: ${JSON.stringify(entities)}`);
    assert.equal(entities[0]!.operation, 'add_column');
    assert.equal(entities[0]!.column, 'status');
    assert.equal(entities[0]!.table, 'User');
  });

  it('with previousContent containing extra field emits drop_column', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const previous = `
model User {
  id           String @id
  email        String
  legacy_field String
}
`;
    const current = `
model User {
  id    String @id
  email String
}
`;
    const entities = extractFromPrisma(current, previous);
    assert.equal(entities.length, 1, `expected exactly one entity, got: ${JSON.stringify(entities)}`);
    assert.equal(entities[0]!.operation, 'drop_column');
    assert.equal(entities[0]!.column, 'legacy_field');
  });

  it('with previousContent missing a table emits create_table + add_column', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const previous = `model User { id String @id \n  email String }`;
    const current = `
model User { id String @id \n  email String }
model Order { id String @id \n  total Float }
`;
    const entities = extractFromPrisma(current, previous);
    const newTable = entities.find(e => e.operation === 'create_table');
    assert.ok(newTable, 'expected create_table for new Order model');
    assert.equal(newTable!.table, 'Order');
    const newCols = entities.filter(e => e.operation === 'add_column' && e.table === 'Order');
    assert.equal(newCols.length, 1);
    assert.equal(newCols[0]!.column, 'total');
    // User table unchanged → no User entries
    assert.equal(entities.filter(e => e.table === 'User').length, 0);
  });

  it('with previousContent=null falls back to original behavior (treat all as added)', async () => {
    const { extractFromPrisma } = await import('../src/core/schema-alignment/extractor/prisma.ts');
    const content = `model User { id String @id \n  email String }`;
    const entitiesWithoutHistory = extractFromPrisma(content, null);
    const entitiesUndefined = extractFromPrisma(content);
    assert.deepEqual(entitiesWithoutHistory, entitiesUndefined, 'null and undefined should produce identical fallback output');
    assert.ok(entitiesWithoutHistory.some(e => e.operation === 'create_table'));
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
