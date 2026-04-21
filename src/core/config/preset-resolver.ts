import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadConfig } from './loader.ts';
import { AutopilotError } from '../errors.ts';
import type { AutopilotConfig } from './types.ts';

const PRESET_ROOT = path.resolve(process.cwd(), 'presets');

export interface ResolvedPreset {
  name: string;
  config: AutopilotConfig;
  stack: string;
}

export async function resolvePreset(name: string): Promise<ResolvedPreset> {
  const presetDir = path.join(PRESET_ROOT, name);
  try {
    await fs.stat(presetDir);
  } catch {
    throw new AutopilotError(`Preset not found: ${name}`, {
      code: 'invalid_config',
      details: { name, presetDir },
    });
  }

  const config = await loadConfig(path.join(presetDir, 'autopilot.config.yaml'));
  let stack = '';
  try {
    stack = await fs.readFile(path.join(presetDir, 'stack.md'), 'utf8');
  } catch {
    stack = config.stack ?? '';
  }
  return { name, config, stack };
}

export function mergeConfigs(preset: AutopilotConfig, user: AutopilotConfig): AutopilotConfig {
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
