import * as fs from 'node:fs/promises';
import type { Finding } from '../../../src/core/findings/types.ts';
import type { StaticRule } from '../../../src/core/phases/static-rules.ts';

export const supabaseRlsBypassRule: StaticRule = {
  name: 'supabase-rls-bypass',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const clientSideFiles = touchedFiles.filter(f =>
      (f.endsWith('.tsx') || f.includes('/components/')) &&
      !f.includes('/api/') && !f.includes('.test.') && !f.includes('__tests__')
    );

    for (const file of clientSideFiles) {
      let content: string;
      try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
      if (!content.includes('createServiceRoleClient')) continue;

      const lineIndex = content.split('\n').findIndex(l => l.includes('createServiceRoleClient'));
      findings.push({
        id: `supabase-rls-bypass-${file}-${lineIndex}`,
        source: 'static-rules',
        severity: 'critical',
        category: 'supabase-rls-bypass',
        file,
        line: lineIndex >= 0 ? lineIndex + 1 : undefined,
        message: 'createServiceRoleClient() in client-side code — service role key is a RLS bypass',
        suggestion: 'Use createServerSupabase in a server component or route handler',
        protectedPath: true,
        createdAt: new Date().toISOString(),
      });
    }
    return findings;
  },
};

export default supabaseRlsBypassRule;
