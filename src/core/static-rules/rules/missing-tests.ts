import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const SOURCE_DIRS = ['src/', 'app/', 'lib/', 'utils/'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;
const INDEX_FILE = /(?:^|[/\\])index\.[tj]sx?$/;

function isSourceFile(f: string): boolean {
  const ext = f.slice(f.lastIndexOf('.'));
  return SOURCE_EXTS.has(ext) && !TEST_PATH.test(f) && SOURCE_DIRS.some(d => f.startsWith(d));
}

function hasTestCounterpart(file: string, touchedFiles: Set<string>): boolean {
  const base = file.replace(/\.[tj]sx?$/, '');
  const candidates = [
    `${base}.test.ts`, `${base}.test.tsx`, `${base}.test.js`,
    `${base}.spec.ts`, `${base}.spec.tsx`, `${base}.spec.js`,
  ];
  const dir = path.dirname(file);
  const name = path.basename(base);
  candidates.push(
    `${dir}/__tests__/${name}.test.ts`,
    `${dir}/__tests__/${name}.test.tsx`,
    `${dir}/__tests__/${name}.test.js`,
  );
  return candidates.some(c => touchedFiles.has(c) || fs.existsSync(c));
}

export const missingTestsRule: StaticRule = {
  name: 'missing-tests',
  severity: 'note',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const touched = new Set(touchedFiles);
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      if (!isSourceFile(file) || INDEX_FILE.test(file)) continue;
      if (!hasTestCounterpart(file, touched)) {
        findings.push({
          id: `missing-tests:${file}`,
          source: 'static-rules',
          severity: 'note',
          category: 'missing-tests',
          file,
          message: 'No test file found for this changed source file',
          suggestion: `Add tests at ${file.replace(/\.[tj]sx?$/, '.test.ts')}`,
          protectedPath: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return findings;
  },
};
