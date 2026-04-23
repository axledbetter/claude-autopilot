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
