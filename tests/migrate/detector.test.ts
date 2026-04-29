import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detect } from '../../src/core/migrate/detector.ts';

function mkRepo(spec: Record<string, string | true>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'det-'));
  for (const [p, content] of Object.entries(spec)) {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (p.endsWith('/')) {
      fs.mkdirSync(abs, { recursive: true });
    } else if (content === true) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.writeFileSync(abs, content);
    }
  }
  return dir;
}

describe('detect — single high-confidence matches', () => {
  it('Delegance Supabase: data/deltas + supabase-envs.json → nextjs-supabase, migrate.supabase@1', () => {
    const dir = mkRepo({
      'data/deltas/': true,
      '.claude/supabase-envs.json': '{}',
    });
    const r = detect(dir);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.rule.stack, 'nextjs-supabase');
    assert.equal(r.matches[0]!.rule.defaultSkill, 'migrate.supabase@1');
    assert.equal(r.autoSelect, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('Prisma with migrations → prisma-migrate, autoSelect=true', () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model User { id String @id }',
      'prisma/migrations/': true,
    });
    const r = detect(dir);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.rule.stack, 'prisma-migrate');
    assert.equal(r.autoSelect, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('Drizzle with migrations → drizzle-migrate', () => {
    const dir = mkRepo({
      'drizzle.config.ts': 'export default {};',
      'drizzle/migrations/': true,
    });
    const r = detect(dir);
    assert.ok(r.matches.some(m => m.rule.stack === 'drizzle-migrate'));
    fs.rmSync(dir, { recursive: true });
  });

  it('Rails: db/migrate/ + Gemfile with rails → rails', () => {
    const dir = mkRepo({
      'db/migrate/': true,
      'Gemfile': "gem 'rails', '~> 7.0'\n",
    });
    const r = detect(dir);
    assert.ok(r.matches.some(m => m.rule.stack === 'rails'));
    fs.rmSync(dir, { recursive: true });
  });

  it('Flyway via flyway.conf → flyway', () => {
    const dir = mkRepo({ 'flyway.conf': 'flyway.url=jdbc:postgresql://...' });
    const r = detect(dir);
    assert.ok(r.matches.some(m => m.rule.stack === 'flyway'));
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detect — low/medium confidence triggers prompt', () => {
  it('Prisma without migrations → prisma-push, low, prompt=true', () => {
    const dir = mkRepo({ 'prisma/schema.prisma': 'model X {}' });
    const r = detect(dir);
    assert.ok(r.matches.some(m => m.rule.stack === 'prisma-push' && m.confidence === 'low'));
    assert.equal(r.autoSelect, false);
    assert.equal(r.prompt, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('Alembic alone → medium, prompt=true', () => {
    const dir = mkRepo({ 'alembic.ini': '[alembic]' });
    const r = detect(dir);
    assert.ok(r.matches.some(m => m.rule.stack === 'alembic' && m.confidence === 'medium'));
    assert.equal(r.prompt, true);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detect — exclusion rules', () => {
  it('supabase-bare excluded when supabase/migrations present', () => {
    const dir = mkRepo({ 'supabase/': true, 'supabase/migrations/': true });
    const r = detect(dir);
    assert.equal(r.matches.filter(m => m.rule.stack === 'supabase-bare').length, 0);
    assert.ok(r.matches.some(m => m.rule.stack === 'supabase-cli'));
    fs.rmSync(dir, { recursive: true });
  });

  it('Rails Gemfile without "rails" string → no rails match', () => {
    const dir = mkRepo({
      'db/migrate/': true,
      'Gemfile': "gem 'sinatra'",
    });
    const r = detect(dir);
    assert.equal(r.matches.filter(m => m.rule.stack === 'rails').length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detect — zero matches', () => {
  it('empty repo → no matches, no autoSelect, no prompt', () => {
    const dir = mkRepo({ 'README.md': 'just a readme' });
    const r = detect(dir);
    assert.equal(r.matches.length, 0);
    assert.equal(r.autoSelect, false);
    assert.equal(r.prompt, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('detect — multiple matches force prompt', () => {
  it('Prisma + Drizzle in same repo → both match, autoSelect=false', () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model X {}',
      'prisma/migrations/': true,
      'drizzle.config.ts': 'export default {};',
      'drizzle/migrations/': true,
    });
    const r = detect(dir);
    assert.ok(r.matches.length >= 2);
    assert.equal(r.autoSelect, false);
    assert.equal(r.prompt, true);
    fs.rmSync(dir, { recursive: true });
  });
});
