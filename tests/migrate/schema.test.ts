// tests/migrate/schema.test.ts
//
// Validates fixture stack.md JSON payloads against the JSON Schema using
// raw ajv (the schema-validator.ts wrapper with the custom stableSkillId
// keyword lands in Task 2.2).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../presets/schemas/migrate.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

describe('migrate.schema.json — migrate@1 shape', () => {
  it('accepts minimal valid migrate@1 stack.md', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {
          dev: { command: { exec: 'prisma', args: ['migrate', 'dev'] } }
        }
      }
    });
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('accepts full migrate@1 stack.md with envs/post/policy', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {
          dev: { command: { exec: 'prisma', args: ['migrate', 'dev', '--skip-seed'] } },
          staging: {
            command: { exec: 'prisma', args: ['migrate', 'deploy'] },
            env_file: '.env.staging'
          },
          prod: {
            command: { exec: 'prisma', args: ['migrate', 'deploy'] },
            env_file: '.env.prod'
          }
        },
        post: [{ command: { exec: 'prisma', args: ['generate'] } }],
        policy: {
          allow_prod_in_ci: false,
          require_clean_git: true,
          require_manual_approval: true,
          require_dry_run_first: false
        },
        detected_at: '2026-04-29T18:00:00Z',
        project_root: '.'
      }
    });
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects migrate@1 without envs.dev', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {} // missing dev
      }
    });
    assert.equal(ok, false);
  });

  it('rejects shell metacharacters in args[]', () => {
    const cases = ['|', ';', '&', '>', '<', '`', '$()'];
    for (const meta of cases) {
      const ok = validate({
        schema_version: 1,
        migrate: {
          skill: 'migrate@1',
          envs: {
            dev: { command: { exec: 'prisma', args: [`migrate${meta}dev`] } }
          }
        }
      });
      assert.equal(ok, false, `expected reject for arg containing ${meta}`);
    }
  });

  it('accepts safe args (flags, paths, hyphens)', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {
          dev: {
            command: {
              exec: 'prisma',
              args: ['migrate', 'dev', '--skip-seed', '--name=add-status']
            }
          }
        }
      }
    });
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects absolute env_file path', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {
          dev: {
            command: { exec: 'prisma', args: ['migrate', 'dev'] },
            env_file: '/etc/passwd'
          }
        }
      }
    });
    assert.equal(ok, false);
  });

  it('rejects env_file with ..', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate@1',
        envs: {
          dev: {
            command: { exec: 'prisma', args: ['migrate', 'dev'] },
            env_file: '../secrets/.env'
          }
        }
      }
    });
    assert.equal(ok, false);
  });
});

describe('migrate.schema.json — migrate.supabase@1 shape', () => {
  it('accepts valid supabase stack.md', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate.supabase@1',
        supabase: {
          deltas_dir: 'data/deltas',
          types_out: 'types/supabase.ts',
          envs_file: '.claude/supabase-envs.json'
        },
        policy: { allow_prod_in_ci: false }
      }
    });
    assert.ok(ok, JSON.stringify(validate.errors));
  });

  it('rejects supabase without deltas_dir', () => {
    const ok = validate({
      schema_version: 1,
      migrate: {
        skill: 'migrate.supabase@1',
        supabase: {
          types_out: 'types/supabase.ts',
          envs_file: '.claude/supabase-envs.json'
        }
      }
    });
    assert.equal(ok, false);
  });
});

describe('migrate.schema.json — none@1 shape', () => {
  it('accepts minimal none@1 stack.md', () => {
    const ok = validate({
      schema_version: 1,
      migrate: { skill: 'none@1' }
    });
    assert.ok(ok, JSON.stringify(validate.errors));
  });
});

describe('migrate.schema.json — stable ID format', () => {
  it('accepts stable ID with version suffix', () => {
    for (const id of ['migrate@1', 'migrate.supabase@1', 'none@1', 'foo.bar.baz@99']) {
      const ok = validate({
        schema_version: 1,
        migrate: id === 'migrate.supabase@1'
          ? {
              skill: id,
              supabase: { deltas_dir: 'd', types_out: 't', envs_file: 'e' }
            }
          : id === 'migrate@1'
            ? { skill: id, envs: { dev: { command: { exec: 'x', args: [] } } } }
            : { skill: id }
      });
      assert.ok(ok, `expected ${id} accepted: ${JSON.stringify(validate.errors)}`);
    }
  });

  it('rejects stable ID without version suffix', () => {
    const ok = validate({
      schema_version: 1,
      migrate: { skill: 'migrate' }
    });
    assert.equal(ok, false);
  });

  it('rejects stable ID with uppercase', () => {
    const ok = validate({
      schema_version: 1,
      migrate: { skill: 'Migrate@1' }
    });
    assert.equal(ok, false);
  });
});
