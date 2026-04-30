/**
 * Schema introspection helpers for the migration runner.
 *
 * Exports:
 *   inspectObject(executor, name)  — formatted metadata for one table, function, or trigger
 *   generateSchemaSummary(executor) — full schema summary as markdown
 */

import type { MigrationExecutor } from './types';

// ── SQL Queries ──

const TABLES_QUERY = `
SELECT t.table_name,
  json_agg(json_build_object(
    'column', c.column_name, 'type', c.data_type, 'udt', c.udt_name,
    'nullable', c.is_nullable, 'default', c.column_default
  ) ORDER BY c.ordinal_position) as columns
FROM information_schema.tables t
JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
GROUP BY t.table_name ORDER BY t.table_name;
`.trim();

const FUNCTIONS_QUERY = `
SELECT p.proname as name,
  pg_get_function_arguments(p.oid) as args,
  pg_get_function_result(p.oid) as returns,
  l.lanname as language,
  p.provolatile as volatility,
  p.prosecdef as security_definer
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN pg_language l ON p.prolang = l.oid
WHERE n.nspname = 'public'
ORDER BY p.proname;
`.trim();

const TRIGGERS_QUERY = `
SELECT c.relname as table_name, tg.tgname as trigger_name,
  pg_get_triggerdef(tg.oid) as definition
FROM pg_trigger tg
JOIN pg_class c ON tg.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE NOT tg.tgisinternal AND n.nspname = 'public'
ORDER BY c.relname, tg.tgname;
`.trim();

const CONSTRAINTS_QUERY = `
SELECT conrelid::regclass::text as table_name, conname,
  CASE contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' ELSE contype::text END as type
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, conname;
`.trim();

const RLS_QUERY = `
SELECT tablename, policyname, cmd, roles,
  SUBSTRING(qual::text FROM 1 FOR 80) as using_expr
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;
`.trim();

const INDEXES_QUERY = `
SELECT tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public'
ORDER BY tablename, indexname;
`.trim();

// ── Row Types ──

interface TableRow {
  table_name: string;
  columns: Array<{
    column: string;
    type: string;
    udt: string;
    nullable: string;
    default: string | null;
  }>;
}

interface FunctionRow {
  name: string;
  args: string;
  returns: string;
  language: string;
  volatility: string;
  security_definer: boolean;
}

interface TriggerRow {
  table_name: string;
  trigger_name: string;
  definition: string;
}

interface ConstraintRow {
  table_name: string;
  conname: string;
  type: string;
}

interface RlsRow {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string[] | string;
  using_expr: string | null;
}

interface IndexRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

// ── Volatility Mapping ──

function volatilityLabel(v: string): string {
  switch (v) {
    case 'i': return 'IMMUTABLE';
    case 's': return 'STABLE';
    case 'v': return 'VOLATILE';
    default:  return v;
  }
}

// ── inspectObject ──

export async function inspectObject(executor: MigrationExecutor, name: string): Promise<string> {
  const nameLower = name.toLowerCase();

  // 1. Try as table
  const tables = await executor.query<TableRow>(TABLES_QUERY);
  const table = tables.find(t => t.table_name.toLowerCase() === nameLower);
  if (table) {
    const constraints = await executor.query<ConstraintRow>(CONSTRAINTS_QUERY);
    const rlsRows = await executor.query<RlsRow>(RLS_QUERY);
    const triggers = await executor.query<TriggerRow>(TRIGGERS_QUERY);
    const indexes = await executor.query<IndexRow>(INDEXES_QUERY);

    const tableConstraints = constraints.filter(c =>
      c.table_name.toLowerCase() === nameLower || c.table_name.toLowerCase() === `public.${nameLower}`
    );
    const tableRls = rlsRows.filter(r => r.tablename.toLowerCase() === nameLower);
    const tableTriggers = triggers.filter(t => t.table_name.toLowerCase() === nameLower);
    const tableIndexes = indexes.filter(i => i.tablename.toLowerCase() === nameLower);

    const lines: string[] = [`## Table: ${table.table_name}`, ''];

    // Columns
    lines.push('### Columns');
    lines.push('| Column | Type | Nullable | Default |');
    lines.push('|--------|------|----------|---------|');
    const cols = Array.isArray(table.columns) ? table.columns : JSON.parse(table.columns as unknown as string);
    for (const col of cols) {
      const displayType = col.udt && col.udt !== col.type ? `${col.type} (${col.udt})` : col.type;
      lines.push(`| ${col.column} | ${displayType} | ${col.nullable} | ${col.default ?? '—'} |`);
    }
    lines.push('');

    // Constraints
    if (tableConstraints.length > 0) {
      lines.push('### Constraints');
      for (const c of tableConstraints) {
        lines.push(`- **${c.conname}** (${c.type})`);
      }
      lines.push('');
    }

    // RLS
    if (tableRls.length > 0) {
      lines.push('### RLS Policies');
      for (const r of tableRls) {
        const roles = Array.isArray(r.roles) ? r.roles.join(', ') : r.roles;
        lines.push(`- **${r.policyname}** [${r.cmd}] roles=${roles}${r.using_expr ? ` USING: ${r.using_expr}` : ''}`);
      }
      lines.push('');
    }

    // Triggers
    if (tableTriggers.length > 0) {
      lines.push('### Triggers');
      for (const t of tableTriggers) {
        lines.push(`- **${t.trigger_name}**: ${t.definition}`);
      }
      lines.push('');
    }

    // Indexes
    if (tableIndexes.length > 0) {
      lines.push('### Indexes');
      for (const i of tableIndexes) {
        lines.push(`- **${i.indexname}**: ${i.indexdef}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // 2. Try as function
  const functions = await executor.query<FunctionRow>(FUNCTIONS_QUERY);
  const funcs = functions.filter(f => f.name.toLowerCase() === nameLower);
  if (funcs.length > 0) {
    const lines: string[] = [`## Function: ${name}`, ''];
    lines.push('| Args | Returns | Language | Volatility | Security |');
    lines.push('|------|---------|----------|------------|----------|');
    for (const f of funcs) {
      lines.push(
        `| ${f.args || '(none)'} | ${f.returns} | ${f.language} | ${volatilityLabel(f.volatility)} | ${f.security_definer ? 'DEFINER' : 'INVOKER'} |`
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  // 3. Try as trigger
  const triggers = await executor.query<TriggerRow>(TRIGGERS_QUERY);
  const trig = triggers.find(t => t.trigger_name.toLowerCase() === nameLower);
  if (trig) {
    const lines: string[] = [`## Trigger: ${trig.trigger_name}`, ''];
    lines.push(`**Table:** ${trig.table_name}`);
    lines.push('');
    lines.push('**Definition:**');
    lines.push('```sql');
    lines.push(trig.definition);
    lines.push('```');
    lines.push('');
    return lines.join('\n');
  }

  return `Object '${name}' not found as a table, function, or trigger in schema 'public'.\n`;
}

// ── generateSchemaSummary ──

export async function generateSchemaSummary(executor: MigrationExecutor, env?: string): Promise<string> {
  const [tables, functions, triggers, constraints, rlsRows, indexes] = await Promise.all([
    executor.query<TableRow>(TABLES_QUERY),
    executor.query<FunctionRow>(FUNCTIONS_QUERY),
    executor.query<TriggerRow>(TRIGGERS_QUERY),
    executor.query<ConstraintRow>(CONSTRAINTS_QUERY),
    executor.query<RlsRow>(RLS_QUERY),
    executor.query<IndexRow>(INDEXES_QUERY),
  ]);

  // Index lookups
  const constraintsByTable = groupBy(constraints, c => normalizeTableName(c.table_name));
  const rlsByTable = groupBy(rlsRows, r => r.tablename);
  const triggersByTable = groupBy(triggers, t => t.table_name);

  const lines: string[] = [];

  // Header — no timestamp to keep diffs clean
  lines.push(`<!-- AUTO-GENERATED by scripts/supabase/schema-inspect.ts — DO NOT EDIT -->`);
  lines.push(`<!-- Generated from: ${env ?? 'unknown'} -->`);
  lines.push('');
  lines.push('# Schema Summary');
  lines.push('');

  // ── Tables ──
  lines.push(`## Tables (${tables.length})`);
  lines.push('');

  for (const table of tables) {
    lines.push(`### ${table.table_name}`);

    // Columns
    lines.push('| Column | Type | Nullable | Default |');
    lines.push('|--------|------|----------|---------|');
    const cols = Array.isArray(table.columns) ? table.columns : JSON.parse(table.columns as unknown as string);
    for (const col of cols) {
      const displayType = col.udt && col.udt !== col.type ? `${col.type} (${col.udt})` : col.type;
      lines.push(`| ${col.column} | ${displayType} | ${col.nullable} | ${col.default ?? '—'} |`);
    }

    // Constraints (inline)
    const tableConstraints = constraintsByTable.get(table.table_name) ?? [];
    if (tableConstraints.length > 0) {
      const constraintStr = tableConstraints.map(c => `${c.conname} (${c.type})`).join(', ');
      lines.push(`Constraints: ${constraintStr}`);
    }

    // RLS inline
    const tableRls = rlsByTable.get(table.table_name) ?? [];
    if (tableRls.length > 0) {
      const policyNames = tableRls.map(r => `${r.policyname} (${r.cmd})`).join(', ');
      lines.push(`RLS: enabled | Policies: ${policyNames}`);
    }

    // Triggers inline
    const tableTriggers = triggersByTable.get(table.table_name) ?? [];
    if (tableTriggers.length > 0) {
      const trigStr = tableTriggers.map(t => {
        // Extract function name from definition: "... EXECUTE FUNCTION foo()" or "EXECUTE PROCEDURE foo()"
        const match = t.definition.match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w."]+\([^)]*\))/i);
        const fn = match ? match[1] : '…';
        return `${t.trigger_name} → ${fn}`;
      }).join(', ');
      lines.push(`Triggers: ${trigStr}`);
    }

    lines.push('');
  }

  // ── Functions ──
  lines.push(`## Functions (${functions.length})`);
  lines.push('');
  lines.push('| Function | Returns | Lang | Volatility | Security |');
  lines.push('|----------|---------|------|------------|----------|');
  for (const f of functions) {
    const sig = `${f.name}(${f.args})`;
    lines.push(
      `| ${sig} | ${f.returns} | ${f.language} | ${volatilityLabel(f.volatility)} | ${f.security_definer ? 'DEFINER' : 'INVOKER'} |`
    );
  }
  lines.push('');

  // ── Triggers ──
  lines.push(`## Triggers (${triggers.length})`);
  lines.push('');
  if (triggers.length > 0) {
    lines.push('| Table | Trigger | Definition |');
    lines.push('|-------|---------|------------|');
    for (const t of triggers) {
      // Truncate long definitions to keep table readable
      const def = t.definition.length > 120 ? t.definition.slice(0, 117) + '...' : t.definition;
      lines.push(`| ${t.table_name} | ${t.trigger_name} | ${def} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Helpers ──

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) {
      existing.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}

/** pg_constraint returns "public.tablename" for the regclass cast; normalize to just tablename */
function normalizeTableName(name: string): string {
  return name.replace(/^public\./, '');
}
