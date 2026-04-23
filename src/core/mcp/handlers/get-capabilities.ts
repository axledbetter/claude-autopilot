import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace } from '../workspace.ts';
import type { GuardrailConfig, StaticRuleReference } from '../../config/types.ts';

export interface CapabilitiesResult {
  schema_version: 1;
  adapter: string;
  enabledRules: string[];
  writeable: boolean;
  gitAvailable: boolean;
  testCommandConfigured: boolean;
  guardrailVersion: string;
}

function readVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../package.json');
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function isGitAvailable(workspace: string): boolean {
  try {
    // Safe: no user input, static arguments only
    child_process.execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: workspace,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function extractRuleName(rule: StaticRuleReference): string {
  return typeof rule === 'string' ? rule : rule.adapter;
}

export async function handleGetCapabilities(
  input: { cwd?: string },
  config: GuardrailConfig,
  adapterName: string,
): Promise<CapabilitiesResult> {
  const workspace = resolveWorkspace(input.cwd);
  const staticRules = config.staticRules ?? [];
  const enabledRules = staticRules.map(extractRuleName);

  return {
    schema_version: 1,
    adapter: adapterName,
    enabledRules,
    writeable: true,
    gitAvailable: isGitAvailable(workspace),
    testCommandConfigured: !!config.testCommand,
    guardrailVersion: readVersion(),
  };
}
