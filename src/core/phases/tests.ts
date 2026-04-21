import { execSync } from 'node:child_process';
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

  let output: string | undefined;
  try {
    // shell:true so testCommand can contain quoted args, pipes, etc.
    // testCommand is developer-supplied config, not user input.
    output = execSync(input.testCommand, {
      encoding: 'utf8',
      cwd: input.cwd,
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
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
