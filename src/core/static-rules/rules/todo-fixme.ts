import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/;
const SKIP_EXTS = new Set(['.lock', '.snap', '.png', '.jpg', '.svg', '.ico']);

export const todoFixmeRule: StaticRule = {
  name: 'todo-fixme',
  severity: 'note',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (SKIP_EXTS.has(ext)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i]!.match(TODO_PATTERN);
        if (match) {
          findings.push({
            id: `todo-fixme:${file}:${i + 1}`,
            source: 'static-rules',
            severity: 'note',
            category: 'todo-fixme',
            file,
            line: i + 1,
            message: `${match[1]} comment in changed file`,
            suggestion: 'Resolve before merging or track in an issue',
            protectedPath: false,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    return findings;
  },
};
