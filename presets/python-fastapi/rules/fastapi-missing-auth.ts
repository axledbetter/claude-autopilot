import type { StaticRule } from '../../../src/core/phases/static-rules.ts';
import type { Finding } from '../../../src/core/findings/types.ts';
import * as fs from 'node:fs/promises';

// Routes that are decorated with state-mutating HTTP verbs but lack a Depends() auth call
const MUTATION_DECORATOR = /@(app|router)\.(post|put|patch|delete)\s*\(/i;
const HAS_AUTH_DEP = /Depends\s*\(\s*(?:get_current_user|require_auth|authenticate|verify_token)/i;

export const fastapiMissingAuthRule: StaticRule = {
  name: 'fastapi-missing-auth',
  severity: 'critical',
  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const pyFiles = touchedFiles.filter(f => f.endsWith('.py') && f.includes('router'));
    for (const file of pyFiles) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!MUTATION_DECORATOR.test(line)) continue;
          // Check the next 20 lines for the auth dependency
          const block = lines.slice(i, i + 20).join('\n');
          if (!HAS_AUTH_DEP.test(block)) {
            findings.push({
              id: `fastapi-missing-auth:${file}:${i + 1}`,
              source: 'static-rules',
              severity: 'critical',
              category: 'fastapi-missing-auth',
              file,
              line: i + 1,
              message: 'Mutation endpoint may be missing auth dependency',
              suggestion: 'Add current_user: User = Depends(get_current_user) to the route parameters',
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

export default fastapiMissingAuthRule;
