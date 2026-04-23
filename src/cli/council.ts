// src/cli/council.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../core/config/loader.ts';
import { parseCouncilConfig } from '../core/council/config.ts';
import { runCouncil } from '../core/council/runner.ts';
import { makeClaudeCouncilAdapter } from '../adapters/council/claude.ts';
import { makeOpenAICouncilAdapter } from '../adapters/council/openai.ts';
import type { CouncilAdapter } from '../adapters/council/types.ts';
import type { CouncilModelEntry } from '../core/council/types.ts';
import { GuardrailError } from '../core/errors.ts';

function makeAdapter(entry: CouncilModelEntry): CouncilAdapter {
  switch (entry.adapter) {
    case 'claude': return makeClaudeCouncilAdapter(entry.model, entry.label);
    case 'openai': return makeOpenAICouncilAdapter(entry.model, entry.label);
  }
}

export async function runCouncilCmd(opts: {
  prompt?: string;
  contextFile?: string;
  configPath?: string;
  dryRun?: boolean;
  noSynthesize?: boolean;
}): Promise<number> {
  const cwd = process.cwd();
  const configPath = opts.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    console.error(err instanceof GuardrailError ? err.message : String(err));
    return 1;
  }

  if (!config.council) {
    console.error('[council] No "council" section in guardrail.config.yaml — add council.models and council.synthesizer');
    return 1;
  }

  let councilConfig;
  try {
    councilConfig = parseCouncilConfig(config.council as Record<string, unknown>);
  } catch (err) {
    console.error(err instanceof GuardrailError ? err.message : String(err));
    return 1;
  }

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify({ schema_version: 1, status: 'dry_run', config: councilConfig }, null, 2) + '\n');
    return 0;
  }

  if (!opts.prompt) {
    console.error('[council] --prompt is required');
    return 1;
  }
  if (!opts.contextFile) {
    console.error('[council] --context-file is required');
    return 1;
  }

  let contextDoc: string;
  try {
    contextDoc = fs.readFileSync(opts.contextFile, 'utf8');
  } catch {
    console.error(`[council] Cannot read context file: ${opts.contextFile}`);
    return 1;
  }

  const adapters = councilConfig.models.map(makeAdapter);
  const synthesizer = opts.noSynthesize
    ? { label: 'none', consult: async () => '' } as CouncilAdapter
    : makeAdapter(councilConfig.synthesizer);

  const result = await runCouncil(
    councilConfig,
    adapters,
    synthesizer,
    opts.prompt,
    contextDoc,
  );

  // When no-synthesize, clear the empty synthesis object
  if (opts.noSynthesize && result.synthesis?.text === '') {
    delete (result as Record<string, unknown>)['synthesis'];
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.status === 'failed') return 2;
  if (result.status === 'partial') return 1;
  return 0;
}
