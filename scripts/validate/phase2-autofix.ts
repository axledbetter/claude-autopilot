import * as fs from 'fs';
import { runSafe } from './exec-utils';
import { Finding, PhaseResult } from './types';
import { isProtectedPath } from './protected-paths';

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, 'severity' | 'category' | 'file' | 'message'>
): Finding {
  return {
    id: `phase2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    phase: 'autofix',
    line: undefined,
    suggestion: undefined,
    status: 'open',
    fixAttempted: false,
    fixCommitSha: undefined,
    protectedPath: false,
    ...overrides,
  };
}

function runEslintFix(tsFiles: string[]): Finding[] {
  const findings: Finding[] = [];
  if (tsFiles.length === 0) return findings;

  const result = runSafe('npx', ['eslint', '--fix', '--quiet', ...tsFiles]);
  // runSafe returns null on non-zero exit (ESLint exits 1 when unfixable errors remain)
  if (result === null) {
    findings.push(
      makeFinding({
        severity: 'warning',
        category: 'eslint',
        file: tsFiles[0],
        message: `ESLint reported unfixable errors in ${tsFiles.length} file(s) — run: npx eslint ${tsFiles.join(' ')}`,
        suggestion: 'Fix remaining ESLint errors manually',
        fixAttempted: true,
      })
    );
  }
  return findings;
}

function scanFilePatterns(file: string): Finding[] {
  const findings: Finding[] = [];

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return findings;
  }

  const isTestFile =
    file.includes('__tests__') ||
    file.endsWith('.test.ts') ||
    file.endsWith('.test.tsx');

  // Check for console.log in non-test files
  if (!isTestFile) {
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('console.log(')) {
        findings.push(
          makeFinding({
            severity: 'note',
            category: 'console-log',
            file,
            line: idx + 1,
            message: 'console.log() found — use logger from @/utils/logger instead',
            suggestion: 'Replace console.log with logger.info/warn/error',
            status: 'open',
          })
        );
      }
    });
  }

  // Check for unused imports (heuristic: import name appears only once in file = the import itself)
  const importRegex =
    /^import\s+(?:(?:\*\s+as\s+(\w+))|(?:\{([^}]+)\})|(\w+))(?:\s*,\s*(?:\{([^}]+)\}|\*\s+as\s+(\w+)))?/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    // Skip type-only imports — they are stripped at compile time and commonly appear once
    const matchedLine = content.slice(match.index, content.indexOf('\n', match.index));
    if (matchedLine.trimStart().startsWith('import type')) continue;

    const candidates: string[] = [];

    if (match[1]) candidates.push(match[1]);
    if (match[2]) {
      match[2].split(',').forEach(part => {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias) candidates.push(alias);
      });
    }
    if (match[3]) candidates.push(match[3]);
    if (match[4]) {
      match[4].split(',').forEach(part => {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias) candidates.push(alias);
      });
    }
    if (match[5]) candidates.push(match[5]);

    for (const name of candidates) {
      if (!name || name === 'type') continue;
      const occurrences = (content.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
      if (occurrences === 1) {
        const lineNumber = content.slice(0, match.index).split('\n').length;
        findings.push(
          makeFinding({
            severity: 'note',
            category: 'unused-import',
            file,
            line: lineNumber,
            message: `Possibly unused import: "${name}"`,
            suggestion: `Remove unused import "${name}" to keep the file clean`,
          })
        );
      }
    }
  }

  return findings;
}

export async function runPhase2(touchedFiles: string[]): Promise<PhaseResult> {
  const start = Date.now();
  const findings: Finding[] = [];

  const tsFiles = touchedFiles.filter(
    f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !isProtectedPath(f)
  );
  const protectedTsFiles = touchedFiles.filter(
    f => (f.endsWith('.ts') || f.endsWith('.tsx')) && isProtectedPath(f)
  );

  // Add skipped findings for protected paths
  for (const file of protectedTsFiles) {
    findings.push(
      makeFinding({
        severity: 'note',
        category: 'protected-path',
        file,
        message: `Skipped auto-fix for protected path: ${file}`,
        status: 'skipped',
        protectedPath: true,
      })
    );
  }

  // Filter out deleted/non-existent files before passing to ESLint or scanning
  const existingTsFiles = tsFiles.filter(f => fs.existsSync(f));

  // Run ESLint fix on non-protected TS/TSX files that exist on disk
  const eslintFindings = runEslintFix(existingTsFiles);
  findings.push(...eslintFindings);

  // Scan each non-protected TS/TSX file for patterns
  for (const file of existingTsFiles) {
    const patternFindings = scanFilePatterns(file);
    findings.push(...patternFindings);
  }

  const hasCritical = findings.some(f => f.severity === 'critical' && f.status !== 'skipped');
  const hasWarning = findings.some(f => f.severity === 'warning' && f.status !== 'skipped');

  let status: PhaseResult['status'] = 'pass';
  if (hasCritical) status = 'fail';
  else if (hasWarning) status = 'warn';

  return {
    phase: 'autofix',
    status,
    findings,
    durationMs: Date.now() - start,
  };
}
