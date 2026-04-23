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
