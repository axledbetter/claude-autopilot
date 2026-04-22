import * as fs from 'node:fs/promises';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import { GuardrailError } from '../errors.ts';
import type { GuardrailConfig } from './types.ts';
import { GUARDRAIL_CONFIG_SCHEMA } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(GUARDRAIL_CONFIG_SCHEMA);

export async function loadConfig(path: string): Promise<GuardrailConfig> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new GuardrailError(`Config file not found: ${path}`, {
      code: 'user_input',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new GuardrailError(`Invalid YAML in ${path}`, {
      code: 'invalid_config',
      details: { path, cause: err instanceof Error ? err.message : String(err) },
    });
  }

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(e => {
      const loc = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '<root>';
      // enum errors: list allowed values
      if (e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)) {
        return `${loc}: must be one of ${(e.params.allowedValues as unknown[]).map(v => JSON.stringify(v)).join(', ')}`;
      }
      // additionalProperties: name the unexpected key
      if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
        return `${loc}: unexpected key "${e.params.additionalProperty as string}"`;
      }
      return `${loc}: ${e.message ?? 'invalid'}`;
    });
    const summary = errors.slice(0, 5).join('\n  ');
    throw new GuardrailError(
      `guardrail.config.yaml is invalid:\n  ${summary}${errors.length > 5 ? `\n  …and ${errors.length - 5} more` : ''}`,
      { code: 'invalid_config', details: { path, errors } },
    );
  }

  return parsed as GuardrailConfig;
}
