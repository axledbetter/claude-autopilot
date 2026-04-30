// src/core/migrate/schema-validator.ts
//
// Wraps the migrate.schema.json with:
// - custom AJV keyword `stableSkillId` for live alias-map membership check
// - cross-field check: rejects when a non-dev env's command structurally
//   equals envs.dev.command (prevents `prisma migrate dev` against prod)
// - YAML parsing layer (returns parse errors as validation errors)
//
// Exposes validateStackMd(yaml: string) → { valid, errors[] }
//
// Compiled validator is module-scoped so it's built once per process.

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { requirePackageRoot } from '../../cli/_pkg-root.ts';

// Resolve presets/ relative to the canonical package root so this works under
// both the source layout (src/core/migrate/*.ts) and the compiled/published
// layout (dist/src/core/migrate/*.js where presets/ ships at the package root,
// not under dist/). The previous __dirname + '../../..' resolution landed at
// <install>/dist/presets/... in the published tarball — file does not exist.
const PKG_ROOT = requirePackageRoot(import.meta.url);
const SCHEMA_PATH = path.resolve(PKG_ROOT, 'presets', 'schemas', 'migrate.schema.json');
const ALIASES_PATH = path.resolve(PKG_ROOT, 'presets', 'aliases.lock.json');

export interface ValidationError {
  message: string;
  path?: string;
  keyword?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface AliasMap {
  schemaVersion: number;
  aliases: Array<{ stableId: string; resolvesTo: string; rawAliases?: string[] }>;
}

function loadStableIds(): Set<string> {
  const data = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8')) as AliasMap;
  return new Set(data.aliases.map(a => a.stableId));
}

function buildValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  // Register standard formats (date-time, uri, email, etc.) so the schema's
  // `format: "date-time"` constraint is actually validated rather than warned-
  // about-and-ignored on every CLI invocation. Pre-5.2.3 every command printed:
  //   "unknown format \"date-time\" ignored in schema at path #/.../detected_at"
  // — twice, since the validator is built lazily in two paths.
  addFormats(ajv);
  const stableIds = loadStableIds();

  // Custom keyword: validates that the value is one of the registered stable IDs.
  ajv.addKeyword({
    keyword: 'stableSkillId',
    type: 'string',
    error: {
      message: (ctx) => `skillId-not-in-registry: '${ctx.data}' is not in aliases.lock.json`,
    },
    validate: (_schema: unknown, data: unknown) => {
      return typeof data === 'string' && stableIds.has(data);
    },
  });

  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  // Inject the custom keyword on migrate.skill (without modifying the on-disk schema).
  if (schema?.properties?.migrate?.properties?.skill) {
    schema.properties.migrate.properties.skill.stableSkillId = true;
  }

  return ajv.compile(schema);
}

const validate = buildValidator();

function commandsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkDevCommandReuse(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const root = (parsed as { migrate?: { envs?: Record<string, { command?: unknown }> } } | null);
  const envs = root?.migrate?.envs;
  if (!envs || typeof envs !== 'object') return errors;
  const devCmd = envs.dev?.command;
  if (!devCmd) return errors;

  for (const [name, spec] of Object.entries(envs)) {
    if (name === 'dev') continue;
    if (spec?.command && commandsEqual(spec.command, devCmd)) {
      errors.push({
        message: `dev-command-reused-for-non-dev: envs.${name}.command equals envs.dev.command — running a dev migration against ${name} is destructive. Set an explicit command for ${name}.`,
        path: `migrate.envs.${name}.command`,
      });
    }
  }
  return errors;
}

function ajvErrorsToValidationErrors(errors: ErrorObject[]): ValidationError[] {
  return errors.map(e => ({
    message: e.message ?? `validation failed at ${e.instancePath}`,
    path: e.instancePath || undefined,
    keyword: e.keyword,
  }));
}

export function validateStackMd(yamlSource: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlSource);
  } catch (err) {
    return {
      valid: false,
      errors: [{
        message: `yaml-parse-failed: ${(err as Error).message}`,
      }],
    };
  }

  const ok = validate(parsed);
  const schemaErrors = ok ? [] : ajvErrorsToValidationErrors(validate.errors ?? []);
  const crossFieldErrors = ok ? checkDevCommandReuse(parsed) : [];

  return {
    valid: ok && crossFieldErrors.length === 0,
    errors: [...schemaErrors, ...crossFieldErrors],
  };
}
