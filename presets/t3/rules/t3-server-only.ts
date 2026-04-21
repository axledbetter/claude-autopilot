import type { StaticRule } from '../../../src/core/phases/static-rules.ts';
import type { Finding } from '../../../src/core/findings/types.ts';
import * as fs from 'node:fs/promises';

export const t3ServerOnlyRule: StaticRule = {
  name: 't3-server-only',
  severity: 'critical',
  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      if (!file.includes('src/server/') && !file.endsWith('.server.ts')) continue;
      try {
        const content = await fs.readFile(file, 'utf8');
        if (!content.includes("'server-only'") && !content.includes('"server-only"')) {
          findings.push({
            id: `t3-server-only:${file}`,
            source: 'static-rules',
            severity: 'critical',
            category: 't3-server-only',
            file,
            message: 'Server utility missing `server-only` import guard',
            suggestion: "Add `import 'server-only'` at the top of this file",
            protectedPath: false,
            createdAt: new Date().toISOString(),
          });
        }
      } catch {
        // file unreadable — skip
      }
    }
    return findings;
  },
};

export default t3ServerOnlyRule;
