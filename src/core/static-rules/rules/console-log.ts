import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const CONSOLE_CALLS = /\bconsole\.(log|debug|info)\s*\(/;
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const consoleLogRule: StaticRule = {
  name: 'console-log',
  severity: 'warning',

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
        if (line.trim().startsWith('//')) continue;
        if (CONSOLE_CALLS.test(line)) {
          findings.push({
            id: `console-log:${file}:${i + 1}`,
            source: 'static-rules',
            severity: 'warning',
            category: 'console-log',
            file,
            line: i + 1,
            message: 'console.log/debug/info left in production code',
            suggestion: 'Remove or replace with a structured logger',
            protectedPath: false,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
    return findings;
  },
};
