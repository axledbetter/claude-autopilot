import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const DEFAULT_THRESHOLD = 500;
const SKIP_EXTS = new Set(['.lock', '.snap', '.map', '.min.js', '.min.css']);

export const largeFileRule: StaticRule = {
  name: 'large-file',
  severity: 'note',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const threshold = parseInt(process.env.AUTOPILOT_LARGE_FILE_LINES ?? '', 10) || DEFAULT_THRESHOLD;
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (SKIP_EXTS.has(ext)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n').length;
      if (lines > threshold) {
        findings.push({
          id: `large-file:${file}`,
          source: 'static-rules',
          severity: 'note',
          category: 'large-file',
          file,
          message: `File is ${lines} lines (threshold: ${threshold})`,
          suggestion: 'Consider splitting into smaller, focused modules',
          protectedPath: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return findings;
  },
};
