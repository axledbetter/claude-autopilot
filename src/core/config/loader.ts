import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import { AutopilotError } from '../errors.ts';
import type { AutopilotConfig } from './types.ts';
import { AUTOPILOT_CONFIG_SCHEMA } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(AUTOPILOT_CONFIG_SCHEMA);

export async function loadConfig(path: string): Promise<AutopilotConfig> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new AutopilotError(`Config file not found: ${path}`, {
      code: 'user_input',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new AutopilotError(`Invalid YAML in ${path}`, {
      code: 'invalid_config',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(e => `${e.instancePath || '<root>'}: ${e.message}`);
    throw new AutopilotError('Config schema validation failed', {
      code: 'invalid_config',
      details: { path, errors },
    });
  }

  return parsed as AutopilotConfig;
}
