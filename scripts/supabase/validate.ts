import type { Finding, ValidationResult } from './types';

/**
 * Extract table names from CREATE TABLE statements (without IF NOT EXISTS).
 * Used for duplicate detection against existing migrations.
 */
function extractCreateTableNames(sql: string): string[] {
  const re = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s+)(?:public\.)?["]?(\w+)["]?/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.push(match[1].toLowerCase());
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract table names that are explicitly dropped in this migration (DROP TABLE [IF EXISTS]).
 * Used to allow drop-and-recreate patterns without false duplicate-detection errors.
 */
function extractDropTableNames(sql: string): Set<string> {
  const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?["]?(\w+)["]?/gi;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.add(match[1].toLowerCase());
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract ALL table names from CREATE TABLE statements (including IF NOT EXISTS).
 * Used for RLS and naming checks.
 */
function extractAllCreateTableNames(sql: string): string[] {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["]?(\w+)["]?/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.push(match[1].toLowerCase());
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract ALL table names preserving original case (for naming convention checks).
 */
function extractAllCreateTableNamesOriginalCase(sql: string): string[] {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["]?(\w+)["]?/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.push(match[1]);
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract table names that have RLS enabled.
 */
function extractRLSEnabledTables(sql: string): Set<string> {
  const re = /ALTER\s+TABLE\s+(?:public\.)?["]?(\w+)["]?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.add(match[1].toLowerCase());
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract table names that have at least one policy.
 */
function extractPolicyTables(sql: string): Set<string> {
  const re = /CREATE\s+POLICY\s+[^;]*?\s+ON\s+(?:public\.)?["]?(\w+)["]?/gi;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.add(match[1].toLowerCase());
    match = re.exec(sql);
  }
  return names;
}

/**
 * Extract column names from ADD COLUMN statements.
 */
function extractAddColumnNames(sql: string): string[] {
  const re = /ADD\s+COLUMN\s+["]?(\w+)["]?/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  match = re.exec(sql);
  while (match !== null) {
    names.push(match[1]);
    match = re.exec(sql);
  }
  return names;
}

/**
 * Check if a name uses camelCase (has a lowercase letter immediately followed by an uppercase letter).
 */
function isCamelCase(name: string): boolean {
  return /[a-z][A-Z]/.test(name);
}

/**
 * Known domain prefixes for table grouping. Tables with these prefixes belong to specific domains.
 */
const DOMAIN_PREFIXES: Record<string, string> = {
  bank: 'banking',
  banking: 'banking',
  carrier: 'automation',
  automation: 'automation',
  email: 'email',
  embed: 'embed',
  surety: 'surety',
  bond: 'surety',
  insurance: 'insurance',
  oauth: 'auth',
  slack: 'integrations',
  notecard: 'notecard',
  partner: 'partner',
};

/**
 * Get the domain prefix and base name from a table name.
 * e.g., "carrier_quote_jobs" → { prefix: "carrier", base: "quote_jobs", domain: "automation" }
 */
function parseTableName(name: string): { prefix: string; base: string; domain: string | null } {
  const parts = name.split('_');
  if (parts.length > 1 && DOMAIN_PREFIXES[parts[0]]) {
    return { prefix: parts[0], base: parts.slice(1).join('_'), domain: DOMAIN_PREFIXES[parts[0]] };
  }
  return { prefix: '', base: name, domain: null };
}

/**
 * Detect naming conflicts between two table names.
 * Returns a description of the conflict, or null if no conflict.
 *
 * Catches:
 * - Same base name with different prefixes ("carriers" vs "insurance_carriers")
 * - Overlapping domain concepts ("carrier_quotes" vs "surety_quotes")
 * - Singular vs plural variants ("carrier" vs "carriers")
 * - Substring containment suggesting redundancy ("users" vs "user_profiles" is OK, but "carriers" vs "carrier" is not)
 */
function getNameSimilarity(nameA: string, nameB: string): string | null {
  const a = parseTableName(nameA);
  const b = parseTableName(nameB);

  // Same base name, different prefix (e.g., "carriers" vs "insurance_carriers")
  if (a.base === b.base && a.prefix !== b.prefix) {
    return `same base "${a.base}" with different prefixes ("${a.prefix || 'none'}" vs "${b.prefix || 'none'}")`;
  }

  // Same base but one is singular/plural of the other
  if (a.base && b.base) {
    if (a.base + 's' === b.base || b.base + 's' === a.base) {
      if (a.prefix === b.prefix) {
        return `singular/plural conflict ("${nameA}" vs "${nameB}")`;
      }
    }
  }

  // One name is a substring of the other and they share a domain
  // e.g., "carrier_quotes" vs "carrier_quote_submissions" is OK (parent-child)
  // but "carriers" vs "carrier" is not
  if (a.domain && b.domain && a.domain === b.domain) {
    if (nameA !== nameB) {
      // Check for very similar short names in the same domain
      const shorter = nameA.length <= nameB.length ? nameA : nameB;
      const longer = nameA.length > nameB.length ? nameA : nameB;
      if (shorter.length > 4 && longer.startsWith(shorter) && !longer.includes('_', shorter.length)) {
        return `possible redundant table in ${a.domain} domain ("${nameA}" vs "${nameB}")`;
      }
    }
  }

  // Cross-domain tables that might be storing the same entity differently
  // e.g., "bank_carriers" vs "carrier_quotes" — same "carrier" concept in different domains
  if (a.domain && b.domain && a.domain !== b.domain) {
    // Check if one table's base references the other's domain entity
    const aWords = new Set(nameA.split('_'));
    const bWords = new Set(nameB.split('_'));
    const overlap = [...aWords].filter(w => bWords.has(w) && w.length > 3);
    if (overlap.length > 0 && (a.base.includes(b.prefix) || b.base.includes(a.prefix))) {
      return `cross-domain overlap on "${overlap.join(', ')}" (${a.domain} vs ${b.domain}) — ensure foreign keys connect properly`;
    }
  }

  return null;
}

/**
 * Validate a SQL migration against project conventions.
 *
 * Checks:
 * 1. duplicate-detection - CREATE TABLE for already-existing tables
 *    (skipped when the current migration explicitly DROPs the same table first)
 * 2. naming-conventions - camelCase table/column names
 * 3. rls-enforcement - CREATE TABLE without RLS + policy
 * 4. destructive - DROP TABLE, DROP COLUMN, TRUNCATE (blocked unless force=true)
 */
export function validateMigrationSQL(
  sql: string,
  filename: string,
  existingMigrationsSql: string[],
  force?: boolean,
): ValidationResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  // 1. Duplicate detection
  // Tables that this migration explicitly drops first are exempt — drop-and-recreate is intentional.
  const droppedInThisMigration = extractDropTableNames(sql);
  const newTableNames = extractCreateTableNames(sql);
  const existingTableNames = new Set<string>();
  for (const migSql of existingMigrationsSql) {
    for (const name of extractAllCreateTableNames(migSql)) {
      existingTableNames.add(name);
    }
  }
  for (const name of newTableNames) {
    if (existingTableNames.has(name) && !droppedInThisMigration.has(name)) {
      errors.push({
        check: 'duplicate-detection',
        severity: 'error',
        message: `Table "${name}" already exists in a previous migration`,
        file: filename,
      });
    }
  }

  // 2. Naming conventions
  const allNewTables = extractAllCreateTableNames(sql);
  const allNewTablesOriginalCase = extractAllCreateTableNamesOriginalCase(sql);
  for (const name of allNewTablesOriginalCase) {
    if (isCamelCase(name)) {
      errors.push({
        check: 'naming-conventions',
        severity: 'error',
        message: `Table name "${name}" uses camelCase; use snake_case instead`,
        file: filename,
      });
    }
  }
  const columnNames = extractAddColumnNames(sql);
  for (const name of columnNames) {
    if (isCamelCase(name)) {
      errors.push({
        check: 'naming-conventions',
        severity: 'error',
        message: `Column name "${name}" uses camelCase; use snake_case instead`,
        file: filename,
      });
    }
  }

  // 3. RLS enforcement (only for CREATE TABLE)
  if (allNewTables.length > 0) {
    const rlsTables = extractRLSEnabledTables(sql);
    const policyTables = extractPolicyTables(sql);
    for (const name of allNewTables) {
      if (!rlsTables.has(name) || !policyTables.has(name)) {
        errors.push({
          check: 'rls-enforcement',
          severity: 'error',
          message: `Table "${name}" is missing RLS enablement and/or policy definition`,
          file: filename,
        });
      }
    }
  }

  // 4. Naming consistency — detect similar-but-divergent table names across migrations
  if (allNewTables.length > 0 && existingTableNames.size > 0) {
    for (const newName of allNewTables) {
      for (const existingName of existingTableNames) {
        if (newName === existingName) continue;
        const similarity = getNameSimilarity(newName, existingName);
        if (similarity) {
          warnings.push({
            check: 'naming-consistency',
            severity: 'warn',
            message: `Table "${newName}" may conflict with existing "${existingName}" — ${similarity}. Verify this is intentional.`,
            file: filename,
          });
        }
      }
    }
  }

  // 5. Destructive operations
  const destructiveRe = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/gi;
  let destructiveMatch: RegExpExecArray | null;
  destructiveMatch = destructiveRe.exec(sql);
  while (destructiveMatch !== null) {
    if (!force) {
      errors.push({
        check: 'destructive',
        severity: 'block',
        message: `Destructive operation "${destructiveMatch[1]}" detected; use --force to allow`,
        file: filename,
      });
    }
    destructiveMatch = destructiveRe.exec(sql);
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}
