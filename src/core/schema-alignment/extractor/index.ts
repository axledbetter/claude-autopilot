// src/core/schema-alignment/extractor/index.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaEntity } from '../types.ts';
import { extractFromSql } from './sql.ts';
import { extractFromPrisma } from './prisma.ts';

export function extract(filePath: string, previousContent?: string | null): SchemaEntity[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (ext === '.sql') return extractFromSql(content);
  if (base === 'schema.prisma' || ext === '.prisma') return extractFromPrisma(content, previousContent);

  process.stderr.write(`[schema-alignment] no extractor for ${ext} files — skipping ${path.basename(filePath)}\n`);
  return [];
}
