import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

// String interpolation or concatenation inside a SQL-like string
const SQL_KEYWORDS = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|INTO|VALUES|SET|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE)\b/i;

// Template literal or concatenation patterns with SQL
const TEMPLATE_SQL = /`[^`]*\$\{[^}]+\}[^`]*`/;
const CONCAT_SQL   = /(?:["'][^"']*["']\s*\+\s*\w|[\w)\]]\s*\+\s*["'][^"']*["'])/;

// Common DB call patterns that accept raw SQL strings
const DB_CALL = /(?:\.query|\.execute|\.exec|\.run|\.prepare|db\.|pool\.|connection\.|knex\.|sequelize\.query|prisma\.\$queryRaw|drizzle\.execute)\s*\(/;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const sqlInjectionRule: StaticRule = {
  name: 'sql-injection',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (!CODE_EXTS.has(ext) || TEST_PATH.test(file)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Look for template literals or concatenation containing SQL keywords
        const hasSql = SQL_KEYWORDS.test(line);
        const hasInterpolation = TEMPLATE_SQL.test(line) || CONCAT_SQL.test(line);
        const isDbCall = DB_CALL.test(line) || (i > 0 && DB_CALL.test(lines[i - 1]!));

        if (hasSql && hasInterpolation) {
          findings.push({
            id: `sql-injection:${file}:${i + 1}`,
            source: 'static-rules',
            severity: 'critical',
            category: 'sql-injection',
            file,
            line: i + 1,
            message: 'Possible SQL injection: user input appears interpolated into SQL string',
            suggestion: 'Use parameterized queries (e.g. db.query("... WHERE id = $1", [id])) or a query builder',
            protectedPath: false,
            createdAt: new Date().toISOString(),
          });
        } else if (isDbCall && hasInterpolation) {
          findings.push({
            id: `sql-injection:${file}:${i + 1}`,
            source: 'static-rules',
            severity: 'critical',
            category: 'sql-injection',
            file,
            line: i + 1,
            message: 'Possible SQL injection: dynamic string passed to DB query method',
            suggestion: 'Use parameterized queries or a typed query builder instead of string concatenation',
            protectedPath: false,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    return findings;
  },
};
