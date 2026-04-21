import type { StaticRule } from '../../../src/core/phases/static-rules.ts';
import type { Finding } from '../../../src/core/findings/types.ts';
import * as fs from 'node:fs/promises';

const INTERPOLATED_WHERE = /\.where\s*\(\s*["'`][^"'`]*#\{/;
const INTERPOLATED_ORDER = /\.order\s*\(\s*["'`][^"'`]*#\{/;

export const railsSqlInjectionRule: StaticRule = {
  name: 'rails-sql-injection',
  severity: 'critical',
  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const rubyFiles = touchedFiles.filter(f => f.endsWith('.rb'));
    for (const file of rubyFiles) {
      try {
        const lines = (await fs.readFile(file, 'utf8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (INTERPOLATED_WHERE.test(line) || INTERPOLATED_ORDER.test(line)) {
            findings.push({
              id: `rails-sql-injection:${file}:${i + 1}`,
              source: 'static-rules',
              severity: 'critical',
              category: 'rails-sql-injection',
              file,
              line: i + 1,
              message: 'SQL injection risk: string interpolation in Active Record query',
              suggestion: 'Use parameterized queries: .where("name = ?", params[:name])',
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

export default railsSqlInjectionRule;
