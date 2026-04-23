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
