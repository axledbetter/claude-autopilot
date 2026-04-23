import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CoverageGap {
  file: string;          // absolute path of source file
  exports: string[];     // names of uncovered exports
  testFile: string;      // where the test should go (may not exist yet)
}

// Matches: export function foo, export const foo, export class Foo, export async function foo
const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function|const|class|let|var)\s+(\w+)/gm;
// Matches: export default
const DEFAULT_EXPORT_RE = /^\s*export\s+default\s+(?:function|class|\w)/;

const TEST_EXTS = new Set(['.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.tsx', '.spec.js']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return TEST_EXTS.has(path.extname(filePath))
    || base.includes('.test.')
    || base.includes('.spec.')
    || filePath.includes('__tests__')
    || filePath.includes('/tests/');
}

function candidateTestPaths(sourceFile: string): string[] {
  const dir = path.dirname(sourceFile);
  const base = path.basename(sourceFile, path.extname(sourceFile));
  const ext = path.extname(sourceFile);
  return [
    path.join(dir, `${base}.test${ext}`),
    path.join(dir, `${base}.test.ts`),
    path.join(dir, '__tests__', `${base}.test${ext}`),
    path.join(dir, '__tests__', `${base}.test.ts`),
    path.join(path.dirname(dir), 'tests', path.basename(dir), `${base}.test.ts`),
  ];
}

function extractExports(content: string): string[] {
  const names = new Set<string>();
  EXPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_RE.exec(content)) !== null) {
    if (m[1]) names.add(m[1]);
  }
  if (DEFAULT_EXPORT_RE.test(content)) names.add('default');
  return [...names];
}

function testCoversExport(testContent: string, exportName: string, sourceBasename: string): boolean {
  if (exportName === 'default') {
    return testContent.includes(sourceBasename) || testContent.includes('import ');
  }
  return testContent.includes(exportName);
}

export function findCoverageGaps(files: string[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTS.has(ext) || isTestFile(file)) continue;

    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

    const exports = extractExports(content);
    if (exports.length === 0) continue;

    // Find existing test file
    const candidates = candidateTestPaths(file);
    const existingTestPath = candidates.find(p => fs.existsSync(p));
    const testFile = existingTestPath ?? candidates[0]!;

    // Check which exports are covered
    let testContent = '';
    if (existingTestPath) {
      try { testContent = fs.readFileSync(existingTestPath, 'utf8'); } catch { /* no test */ }
    }

    const sourceBasename = path.basename(file, ext);
    const uncovered = existingTestPath
      ? exports.filter(name => !testCoversExport(testContent, name, sourceBasename))
      : exports;

    if (uncovered.length > 0) {
      gaps.push({ file, exports: uncovered, testFile });
    }
  }

  return gaps;
}
