/**
 * TypeScript type generator from PostgreSQL information_schema.
 * Converts schema metadata into types/supabase.ts format.
 */

// ── Types ──

export interface SchemaColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

export interface SchemaTable {
  table_name: string;
  columns: SchemaColumn[];
}

export interface SchemaEnum {
  enum_name: string;
  values: string[];
}

export interface SchemaInfo {
  tables: SchemaTable[];
  enums: SchemaEnum[] | null;
}

// ── SQL Query ──

export const SCHEMA_QUERY = `
SELECT
  t.table_name,
  json_agg(
    json_build_object(
      'column_name', c.column_name,
      'data_type', c.data_type,
      'udt_name', c.udt_name,
      'is_nullable', c.is_nullable,
      'column_default', c.column_default
    ) ORDER BY c.ordinal_position
  ) AS columns
FROM information_schema.tables t
JOIN information_schema.columns c
  ON t.table_name = c.table_name
  AND t.table_schema = c.table_schema
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
GROUP BY t.table_name
ORDER BY t.table_name;
`;

export const ENUM_QUERY = `
SELECT
  t.typname AS enum_name,
  json_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;
`;

// ── Type Mapping ──

const UDT_TYPE_MAP: Record<string, string> = {
  text: 'string',
  varchar: 'string',
  char: 'string',
  bpchar: 'string',
  uuid: 'string',
  int2: 'number',
  int4: 'number',
  float4: 'number',
  float8: 'number',
  int8: 'string',
  numeric: 'string',
  decimal: 'string',
  bool: 'boolean',
  json: 'Json',
  jsonb: 'Json',
  timestamptz: 'string',
  timestamp: 'string',
  date: 'string',
  time: 'string',
  timetz: 'string',
  interval: 'string',
  inet: 'string',
  cidr: 'string',
  macaddr: 'string',
  bytea: 'string',
  oid: 'number',
};

export function mapPgTypeToTs(dataType: string, udtName: string): string {
  // Handle ARRAY types: udt_name starts with '_', strip it and look up base type
  if (dataType === 'ARRAY' && udtName.startsWith('_')) {
    const baseUdt = udtName.slice(1);
    const baseType = UDT_TYPE_MAP[baseUdt] ?? 'string';
    return `${baseType}[]`;
  }

  return UDT_TYPE_MAP[udtName] ?? 'string';
}

// ── Table Interface Generator ──

export function generateTableInterface(table: SchemaTable): string {
  const indent = '          ';
  const lines: string[] = [];

  lines.push(`        ${table.table_name}: {`);

  // Row
  lines.push(`${indent}Row: {`);
  for (const col of table.columns) {
    const tsType = mapPgTypeToTs(col.data_type, col.udt_name);
    const nullable = col.is_nullable === 'YES' ? ' | null' : '';
    lines.push(`${indent}  ${col.column_name}: ${tsType}${nullable}`);
  }
  lines.push(`${indent}}`);

  // Insert
  lines.push(`${indent}Insert: {`);
  for (const col of table.columns) {
    const tsType = mapPgTypeToTs(col.data_type, col.udt_name);
    const nullable = col.is_nullable === 'YES' ? ' | null' : '';
    const optional = col.column_default !== null || col.is_nullable === 'YES' ? '?' : '';
    lines.push(`${indent}  ${col.column_name}${optional}: ${tsType}${nullable}`);
  }
  lines.push(`${indent}}`);

  // Update
  lines.push(`${indent}Update: {`);
  for (const col of table.columns) {
    const tsType = mapPgTypeToTs(col.data_type, col.udt_name);
    const nullable = col.is_nullable === 'YES' ? ' | null' : '';
    lines.push(`${indent}  ${col.column_name}?: ${tsType}${nullable}`);
  }
  lines.push(`${indent}}`);

  // Relationships
  lines.push(`${indent}Relationships: []`);

  lines.push(`        }`);

  return lines.join('\n');
}

// ── Full File Generator ──

export function generateTypesFile(schema: SchemaInfo): string {
  const parts: string[] = [];

  // Json type
  parts.push(`export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]
`);

  // Database type
  parts.push(`export type Database = {`);
  parts.push(`  public: {`);
  parts.push(`    Tables: {`);

  for (let i = 0; i < schema.tables.length; i++) {
    parts.push(generateTableInterface(schema.tables[i]));
  }

  parts.push(`    }`);

  // Enums
  if (schema.enums && schema.enums.length > 0) {
    parts.push(`    Enums: {`);
    for (const e of schema.enums) {
      const values = e.values.map((v) => `'${v}'`).join(' | ');
      parts.push(`      ${e.enum_name}: ${values}`);
    }
    parts.push(`    }`);
  }

  parts.push(`  }`);
  parts.push(`}`);
  parts.push('');

  return parts.join('\n');
}
