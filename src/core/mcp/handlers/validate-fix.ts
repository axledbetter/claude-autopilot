import { spawnSync } from 'node:child_process';
import { resolveWorkspace } from '../workspace.ts';
import { withWriteLock } from '../concurrency.ts';
import type { GuardrailConfig } from '../../config/types.ts';

export interface ValidateFixResult {
  schema_version: 1;
  passed: boolean;
  output: string;
  durationMs: number;
}

export async function handleValidateFix(
  input: { cwd?: string; files?: string[] },
  config: GuardrailConfig,
): Promise<ValidateFixResult> {
  const workspace = resolveWorkspace(input.cwd);

  if (!config.testCommand) {
    return { schema_version: 1, passed: true, output: '', durationMs: 0 };
  }

  return withWriteLock(workspace, async () => {
    const start = Date.now();
    const result = spawnSync(config.testCommand!, {
      cwd: workspace,
      shell: true,
      timeout: 120_000,
      encoding: 'utf8',
    });
    const durationMs = Date.now() - start;
    const raw = ((result.stdout ?? '') + (result.stderr ?? '')).slice(0, 4000);

    return {
      schema_version: 1 as const,
      passed: result.status === 0,
      output: raw,
      durationMs,
    };
  });
}
