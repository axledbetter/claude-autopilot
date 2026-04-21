import { runSafe } from '../shell.ts';
import type { Finding } from '../findings/types.ts';

export interface TestsPhaseInput {
  touchedFiles: string[];
  testCommand?: string | null;
  cwd?: string;
}

export interface TestsPhaseResult {
  phase: 'tests';
  status: 'pass' | 'fail' | 'skip';
  findings: Finding[];
  output?: string;
  durationMs: number;
}

export async function runTestsPhase(input: TestsPhaseInput): Promise<TestsPhaseResult> {
  const start = Date.now();

  if (!input.testCommand) {
    return { phase: 'tests', status: 'skip', findings: [], durationMs: Date.now() - start };
  }

  const [cmd, ...args] = input.testCommand.split(' ');
  if (!cmd) {
    return { phase: 'tests', status: 'skip', findings: [], durationMs: Date.now() - start };
  }

  const output = runSafe(cmd, args, { cwd: input.cwd, timeout: 120000 });

  if (output === null) {
    const finding: Finding = {
      id: 'tests-phase-fail',
      source: 'static-rules',
      severity: 'critical',
      category: 'test-failure',
      file: '<tests>',
      message: `Test command failed: ${input.testCommand}`,
      suggestion: 'Fix failing tests before merging',
      protectedPath: false,
      createdAt: new Date().toISOString(),
    };
    return { phase: 'tests', status: 'fail', findings: [finding], output: undefined, durationMs: Date.now() - start };
  }

  return { phase: 'tests', status: 'pass', findings: [], output, durationMs: Date.now() - start };
}
