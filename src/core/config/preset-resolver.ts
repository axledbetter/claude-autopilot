import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from './loader.ts';
import { GuardrailError } from '../errors.ts';
import type { GuardrailConfig } from './types.ts';

const PRESET_ROOT = path.resolve(process.cwd(), 'presets');

export interface ResolvedPreset {
  name: string;
  config: GuardrailConfig;
  stack: string;
}

export async function resolvePreset(name: string): Promise<ResolvedPreset> {
  const presetDir = path.join(PRESET_ROOT, name);
  try {
    await fs.stat(presetDir);
  } catch {
    throw new GuardrailError(`Preset not found: ${name}`, {
      code: 'invalid_config',
      details: { name, presetDir },
    });
  }

  const config = await loadConfig(path.join(presetDir, 'guardrail.config.yaml'));
  let stack = '';
  try {
    stack = await fs.readFile(path.join(presetDir, 'stack.md'), 'utf8');
  } catch {
    stack = config.stack ?? '';
  }
  return { name, config, stack };
}

export function mergeConfigs(preset: GuardrailConfig, user: GuardrailConfig): GuardrailConfig {
  return {
    ...preset,
    ...user,
    // Arrays are concatenated (preset values first) so user additions don't discard preset invariants
    protectedPaths: [...(preset.protectedPaths ?? []), ...(user.protectedPaths ?? [])],
    staticRules: [...(preset.staticRules ?? []), ...(user.staticRules ?? [])],
    thresholds: { ...preset.thresholds, ...user.thresholds },
    chunking: { ...preset.chunking, ...user.chunking },
  };
}
