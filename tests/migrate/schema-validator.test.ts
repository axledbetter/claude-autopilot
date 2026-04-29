// tests/migrate/schema-validator.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateStackMd } from '../../src/core/migrate/schema-validator.ts';

const MIN_MIGRATE_AT_1 = `
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
`;

const MIN_SUPABASE = `
schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".claude/supabase-envs.json"
`;

const NONE = `
schema_version: 1
migrate:
  skill: "none@1"
`;

describe('validateStackMd — stable ID via custom keyword', () => {
  it('accepts known stable IDs (migrate@1, migrate.supabase@1, none@1)', () => {
    for (const yaml of [MIN_MIGRATE_AT_1, MIN_SUPABASE, NONE]) {
      const r = validateStackMd(yaml);
      assert.ok(r.valid, JSON.stringify(r.errors));
    }
  });

  it('rejects unknown stable ID with skillId-not-in-registry error', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "unknown@1"
`);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(e => e.keyword === 'stableSkillId' || /unknown@1/.test(e.message)),
      `expected stableSkillId error, got: ${JSON.stringify(r.errors)}`
    );
  });

  it('rejects raw alias form (must be exact stable ID)', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate"
`);
    assert.equal(r.valid, false);
  });
});

describe('validateStackMd — cross-field: dev command reused for non-dev', () => {
  it('rejects when envs.prod.command equals envs.dev.command', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: ".env.prod"
`);
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(e => /dev-command-reused-for-non-dev/.test(e.message ?? '')),
      `expected dev-command-reused-for-non-dev, got: ${JSON.stringify(r.errors)}`
    );
  });

  it('accepts when envs.prod.command differs (e.g. deploy vs dev)', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
    prod:
      command: { exec: "prisma", args: ["migrate", "deploy"] }
      env_file: ".env.prod"
`);
    assert.ok(r.valid, JSON.stringify(r.errors));
  });

  it('accepts when only dev env is present', () => {
    const r = validateStackMd(MIN_MIGRATE_AT_1);
    assert.ok(r.valid, JSON.stringify(r.errors));
  });
});

describe('validateStackMd — security checks delegated to JSON Schema', () => {
  it('rejects shell metachar in args (delegated to schema)', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate; rm -rf /"] }
`);
    assert.equal(r.valid, false);
  });

  it('rejects ../ in env_file (delegated to schema)', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
  envs:
    dev:
      command: { exec: "prisma", args: ["migrate", "dev"] }
      env_file: "../etc/secret"
`);
    assert.equal(r.valid, false);
  });
});

describe('validateStackMd — error reporting', () => {
  it('returns errors array with field paths for invalid input', () => {
    const r = validateStackMd(`
schema_version: 1
migrate:
  skill: "migrate@1"
`);
    // missing envs.dev for migrate@1
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
    // each error has at least a message
    for (const e of r.errors) {
      assert.ok(typeof e.message === 'string');
    }
  });

  it('handles malformed YAML gracefully', () => {
    const r = validateStackMd(`schema_version: 1\n  migrate: oh\nno`);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => /yaml|parse/i.test(e.message ?? '')));
  });
});
