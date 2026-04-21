import type { StaticRule } from '../../../src/core/phases/static-rules.ts';
import type { Finding } from '../../../src/core/findings/types.ts';
import * as fs from 'node:fs/promises';

// fmt.Sprintf used inside a DB query string
const SPRINTF_IN_QUERY = /(?:Query|Exec|QueryRow)\w*\s*\([^)]*fmt\.Sprintf/;

export const goSqlInjectionRule: StaticRule = {
  name: 'go-sql-injection',
  severity: 'critical',
  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const goFiles = touchedFiles.filter(f => f.endsWith('.go') && !f.endsWith('_test.go'));
    for (const file of goFiles) {
      try {
        const lines = (await fs.readFile(file, 'utf8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (SPRINTF_IN_QUERY.test(lines[i]!)) {
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
