import { run } from './exec-utils';
import { Finding, PhaseResult } from './types';

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, 'severity' | 'category' | 'file' | 'message'>
): Finding {
  return {
    id: `phase4-${crypto.randomUUID()}`,
    phase: 'tests',
    line: undefined,
    suggestion: undefined,
    status: 'open',
    fixAttempted: false,
    fixCommitSha: undefined,
    protectedPath: false,
    ...overrides,
  };
}

function parseTestOutput(output: string): {
  passed: number;
  failed: number;
  failedNames: string[];
} {
  let passed = 0;
  let failed = 0;
  const failedNames: string[] = [];

  // Match "Tests: X passed" pattern
  const passedMatch = output.match(/Tests:\s+(\d+)\s+passed/);
  if (passedMatch) {
    passed = parseInt(passedMatch[1], 10);
  }

  // Match "Tests: X failed" pattern
  const failedMatch = output.match(/Tests:\s+(\d+)\s+failed/);
  if (failedMatch) {
    failed = parseInt(failedMatch[1], 10);
  }

  // Extract failed test names from Jest output
  const failedTestRegex = /●\s+(.+?)(?=\n\s+●|\n\s+expect|\n\n)/g;
  let match: RegExpExecArray | null;
  while ((match = failedTestRegex.exec(output)) !== null) {
    const name = match[1].trim();
    if (name) failedNames.push(name);
  }

  // Also check for "FAIL <path>" lines to capture file-level failures
  const failFileRegex = /FAIL\s+(\S+)/g;
  while ((match = failFileRegex.exec(output)) !== null) {
    const file = match[1].trim();
    if (file && !failedNames.includes(file)) {
      failedNames.push(file);
    }
  }

  return { passed, failed, failedNames };
}

export async function runPhase4(): Promise<PhaseResult> {
  const start = Date.now();
  const findings: Finding[] = [];

  let output: string;
  try {
    output = run('npx', ['tsx', 'scripts/run-affected-tests.ts', '--branch'], {
      timeout: 300000,
    });
  } catch (err: unknown) {
    // run() throws on non-zero exit; capture output from the error
    const spawnError = err as { stdout?: string; stderr?: string; message?: string };
    output = [spawnError.stdout, spawnError.stderr, spawnError.message]
      .filter(Boolean)
      .join('\n');

    const { failed, failedNames } = parseTestOutput(output);
    const testList =
      failedNames.length > 0
        ? failedNames.slice(0, 10).join(', ')
        : 'see test output for details';

    findings.push(
      makeFinding({
        severity: 'critical',
        category: 'test-failure',
        file: 'scripts/run-affected-tests.ts',
        message: `${failed > 0 ? failed : 'Some'} test(s) failed: ${testList}`,
        suggestion: 'Run: npm run test:affected:branch to see full output',
      })
    );

    return {
      phase: 'tests',
      status: 'fail',
      findings,
      durationMs: Date.now() - start,
    };
  }

  const { passed, failed, failedNames } = parseTestOutput(output);

  if (failed > 0) {
    const testList =
      failedNames.length > 0
        ? failedNames.slice(0, 10).join(', ')
        : 'see test output for details';

    findings.push(
      makeFinding({
        severity: 'critical',
        category: 'test-failure',
        file: 'scripts/run-affected-tests.ts',
        message: `${failed} test(s) failed: ${testList}`,
        suggestion: 'Run: npm run test:affected:branch to see full output',
      })
    );
  }

  const status: PhaseResult['status'] = failed > 0 ? 'fail' : 'pass';

  if (passed > 0 && failed === 0) {
    findings.push(
      makeFinding({
        severity: 'note',
        category: 'test-summary',
        file: 'scripts/run-affected-tests.ts',
        message: `All ${passed} affected test(s) passed`,
        status: 'fixed',
      })
    );
  }

  return {
    phase: 'tests',
    status,
    findings,
    durationMs: Date.now() - start,
  };
}
