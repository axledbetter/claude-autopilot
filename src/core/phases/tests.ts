import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

// Detects a Python venv next to the project and prepends its bin/ to PATH so
// commands like `pytest -q` resolve to the venv's binary instead of failing
// with "command not found" or hitting an unrelated system Python. Surfaced by
// the 5.0.8 e2e test on randai-johnson — claude-autopilot pr ran the test
// command from PATH and reported "tests failed" even though the venv-installed
// pytest passed cleanly.
function venvAwareEnv(cwd?: string): NodeJS.ProcessEnv {
  const root = cwd ?? process.cwd();
  for (const candidate of ['.venv', 'venv', 'env']) {
    const binDir = path.join(root, candidate, 'bin');
    if (fs.existsSync(path.join(binDir, 'python')) || fs.existsSync(path.join(binDir, 'python3'))) {
      return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
    }
  }
  return process.env;
}

export async function runTestsPhase(input: TestsPhaseInput): Promise<TestsPhaseResult> {
  const start = Date.now();

  if (!input.testCommand) {
    return { phase: 'tests', status: 'skip', findings: [], durationMs: Date.now() - start };
  }

  let output: string | undefined;
  try {
    // shell:true is intentional — testCommand is developer-supplied config, supports quoted args + pipes.
    output = execSync(input.testCommand, {
      encoding: 'utf8',
      cwd: input.cwd,
      timeout: 120000,
      shell: process.env.SHELL ?? "/bin/sh",
      stdio: ['ignore', 'pipe', 'pipe'],
      env: venvAwareEnv(input.cwd),
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
