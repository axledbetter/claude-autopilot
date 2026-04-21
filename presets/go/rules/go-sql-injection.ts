import type { StaticRule } from '../../../src/core/phases/static-rules.ts';
import type { Finding } from '../../../src/core/findings/types.ts';
import * as fs from 'node:fs/promises';

// fmt.Sprintf directly in a DB call (single-line)
const SPRINTF_IN_QUERY = /(?:Query|Exec|QueryRow)\w*\s*\([^)]*fmt\.Sprintf/;
// fmt.Sprintf result assigned to variable then used in DB call (multi-line)
const SPRINTF_ASSIGN = /\bfmt\.Sprintf\s*\(/;
const DB_CALL = /(?:Query|Exec|QueryRow)\w*\s*\(\s*(\w+)/;

export const goSqlInjectionRule: StaticRule = {
  name: 'go-sql-injection',
  severity: 'critical',
  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const goFiles = touchedFiles.filter(f => f.endsWith('.go') && !f.endsWith('_test.go'));
    for (const file of goFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const lines = content.split('\n');

        // Track variables assigned from fmt.Sprintf (multi-line detection)
        const sprintfVars = new Set<string>();
        for (const line of lines) {
          const m = line.match(/^\s*(\w+)\s*(?::?=)\s*fmt\.Sprintf\s*\(/);
          if (m) sprintfVars.add(m[1]!);
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          let hit = false;

          // Direct inline: db.Query(fmt.Sprintf(...))
          if (SPRINTF_IN_QUERY.test(line)) hit = true;

          // Indirect: variable from fmt.Sprintf passed to DB call
          if (!hit && sprintfVars.size > 0) {
            const dbMatch = line.match(DB_CALL);
            if (dbMatch && sprintfVars.has(dbMatch[1]!)) hit = true;
          }

          if (hit) {
            findings.push({
              id: `go-sql-injection:${file}:${i + 1}`,
              source: 'static-rules',
              severity: 'critical',
              category: 'go-sql-injection',
              file,
              line: i + 1,
              message: 'SQL injection risk: fmt.Sprintf used to build query string',
              suggestion: 'Use parameterized queries: db.Query("WHERE id = $1", id)',
              protectedPath: false,
              createdAt: new Date().toISOString(),
            });
          }
        }
      } catch {
        // unreadable — skip
      }
    }
    return findings;
  },
};

export default goSqlInjectionRule;
