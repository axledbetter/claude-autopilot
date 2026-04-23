import * as fs from 'node:fs';
import * as path from 'node:path';

export type TestFramework = 'jest' | 'vitest' | 'node:test';

export function detectTestFramework(cwd: string): TestFramework {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'node:test';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.devDependencies, ...pkg.dependencies };
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps || '@jest/globals' in deps || 'ts-jest' in deps) return 'jest';
    return 'node:test';
  } catch {
    return 'node:test';
  }
}
