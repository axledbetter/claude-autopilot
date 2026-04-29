// src/core/schema-alignment/extractor/prisma.ts
import type { SchemaEntity } from '../types.ts';

const MODEL_RE = /^model\s+(\w+)\s*\{([^}]+)\}/gm;
const FIELD_RE = /^\s+(\w+)\s+\S/gm;

function parseModels(content: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  for (const modelMatch of content.matchAll(MODEL_RE)) {
    const table = modelMatch[1]!;
    const fields = new Set<string>();
    const body = modelMatch[2]!;
    for (const fieldMatch of body.matchAll(FIELD_RE)) {
      const column = fieldMatch[1]!;
      if (column.startsWith('@') || column === 'id') continue;
      fields.add(column);
    }
    models.set(table, fields);
  }
  return models;
}

/**
 * Extract schema entities from a Prisma schema file.
 *
 * When `previousContent` is provided, only the diff (added/removed fields,
 * new/dropped tables) is emitted — this avoids over-reporting when a user
 * touches schema.prisma for any reason (adding one field, editing a comment)
 * and every long-existing field gets re-checked against type/API/UI layers.
 *
 * When `previousContent` is null/undefined, every model and field is emitted
 * — the original "all entities are new" behavior used as a fallback when git
 * history isn't available.
 */
export function extractFromPrisma(content: string, previousContent?: string | null): SchemaEntity[] {
  const current = parseModels(content);
  if (previousContent === undefined || previousContent === null) {
    const entities: SchemaEntity[] = [];
    for (const [table, fields] of current) {
      entities.push({ table, operation: 'create_table' });
      for (const column of fields) entities.push({ table, column, operation: 'add_column' });
    }
    return entities;
  }

  const previous = parseModels(previousContent);
  const entities: SchemaEntity[] = [];
  for (const [table, currentFields] of current) {
    const previousFields = previous.get(table);
    if (!previousFields) {
      // New table — emit create_table + add_column for every field
      entities.push({ table, operation: 'create_table' });
      for (const column of currentFields) entities.push({ table, column, operation: 'add_column' });
      continue;
    }
    for (const column of currentFields) {
      if (!previousFields.has(column)) entities.push({ table, column, operation: 'add_column' });
    }
    for (const column of previousFields) {
      if (!currentFields.has(column)) entities.push({ table, column, operation: 'drop_column' });
    }
  }
  return entities;
}
