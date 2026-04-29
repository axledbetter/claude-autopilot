// tests/migrate/init-migrate.test.ts
//
// Tests for the init-migrate flow: walk workspaces, run detector,
// write per-workspace stack.md (or root manifest.yaml for monorepos).
// Idempotent re-run preserves user-edited fields.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  initMigrate,
  NoMigrationToolDetectedError,
} from '../../src/cli/init-migrate.ts';

function mkRepo(spec: Record<string, string | true>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-mig-'));
  for (const [p, content] of Object.entries(spec)) {
    const abs = path.join(dir, p);
    if (p.endsWith('/') || content === true) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content as string);
    }
  }
  return dir;
}

function readStackMd(workspace: string): any {
  const p = path.join(workspace, '.autopilot', 'stack.md');
  const content = fs.readFileSync(p, 'utf8');
  return yaml.load(content);
}

describe('initMigrate', () => {
  it('single workspace with high-confidence Prisma match writes correct stack.md', async () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model User { id String @id }',
      'prisma/migrations/': true,
    });

    const result = await initMigrate({ repoRoot: dir });

    assert.equal(result.workspaces.length, 1);
    assert.equal(result.workspaces[0]!.action, 'wrote');
    assert.equal(result.workspaces[0]!.skill, 'migrate@1');

    const stack = readStackMd(dir);
    assert.equal(stack.schema_version, 1);
    assert.equal(stack.migrate.skill, 'migrate@1');
    assert.deepEqual(stack.migrate.envs.dev.command, {
      exec: 'prisma',
      args: ['migrate', 'dev'],
    });
    assert.equal(stack.migrate.policy.allow_prod_in_ci, false);
    assert.equal(stack.migrate.policy.require_clean_git, true);
    assert.equal(stack.migrate.policy.require_manual_approval, true);
    assert.equal(stack.migrate.policy.require_dry_run_first, false);
    assert.ok(stack.migrate.detected_at);
    // ISO timestamp format check
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(stack.migrate.detected_at));
    assert.equal(stack.migrate.project_root, '.');

    fs.rmSync(dir, { recursive: true });
  });

  it('Supabase fixture writes migrate.supabase@1 shape with no envs block', async () => {
    const dir = mkRepo({
      'data/deltas/': true,
      '.claude/supabase-envs.json': '{}',
    });

    const result = await initMigrate({ repoRoot: dir });

    assert.equal(result.workspaces[0]!.skill, 'migrate.supabase@1');
    const stack = readStackMd(dir);
    assert.equal(stack.migrate.skill, 'migrate.supabase@1');
    assert.equal(stack.migrate.envs, undefined);
    assert.equal(stack.migrate.supabase.deltas_dir, 'data/deltas');
    assert.equal(stack.migrate.supabase.types_out, 'types/supabase.ts');
    assert.equal(
      stack.migrate.supabase.envs_file,
      '.claude/supabase-envs.json',
    );
    // Supabase shape only requires allow_prod_in_ci policy default
    assert.equal(stack.migrate.policy.allow_prod_in_ci, false);
    assert.equal(stack.migrate.project_root, '.');

    fs.rmSync(dir, { recursive: true });
  });

  it('--skipMigrate writes none@1 stack.md even with detection matches', async () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model User { id String @id }',
      'prisma/migrations/': true,
    });

    const result = await initMigrate({ repoRoot: dir, skipMigrate: true });

    assert.equal(result.workspaces[0]!.skill, 'none@1');
    const stack = readStackMd(dir);
    assert.equal(stack.migrate.skill, 'none@1');
    assert.equal(stack.migrate.envs, undefined);
    assert.equal(stack.migrate.supabase, undefined);
    assert.ok(stack.migrate.detected_at);

    // Should include the TODO comment
    const raw = fs.readFileSync(
      path.join(dir, '.autopilot', 'stack.md'),
      'utf8',
    );
    assert.ok(/TODO/.test(raw), 'expected TODO comment in stack.md');

    fs.rmSync(dir, { recursive: true });
  });

  it('zero matches without --skipMigrate throws NoMigrationToolDetectedError', async () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({ name: 'plain-app' }),
    });

    await assert.rejects(
      () => initMigrate({ repoRoot: dir }),
      (err: unknown) => {
        assert.ok(err instanceof NoMigrationToolDetectedError);
        assert.match((err as Error).message, /--skip-migrate/);
        return true;
      },
    );

    fs.rmSync(dir, { recursive: true });
  });

  it('idempotent re-run preserves user-edited custom command, only updates detected_at', async () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model User { id String @id }',
      'prisma/migrations/': true,
    });

    // First run
    await initMigrate({ repoRoot: dir });
    const first = readStackMd(dir);
    const firstDetectedAt = first.migrate.detected_at;

    // User customizes the dev command and adds a prod env
    first.migrate.envs.dev.command = {
      exec: 'prisma',
      args: ['migrate', 'deploy', '--my-flag'],
    };
    first.migrate.envs.prod = {
      command: { exec: 'prisma', args: ['migrate', 'deploy'] },
      env_file: '.env.prod',
    };
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'stack.md'),
      yaml.dump(first),
    );

    // Wait at least 1ms to guarantee detected_at differs
    await new Promise(r => setTimeout(r, 5));

    // Second run (no force)
    const result = await initMigrate({ repoRoot: dir });
    assert.equal(result.workspaces[0]!.action, 'updated');

    const second = readStackMd(dir);
    // User customizations preserved
    assert.deepEqual(second.migrate.envs.dev.command, {
      exec: 'prisma',
      args: ['migrate', 'deploy', '--my-flag'],
    });
    assert.deepEqual(second.migrate.envs.prod.command, {
      exec: 'prisma',
      args: ['migrate', 'deploy'],
    });
    assert.equal(second.migrate.envs.prod.env_file, '.env.prod');
    // detected_at refreshed
    assert.notEqual(second.migrate.detected_at, firstDetectedAt);
    // Skill preserved
    assert.equal(second.migrate.skill, 'migrate@1');

    fs.rmSync(dir, { recursive: true });
  });

  it('force: true regenerates from scratch overwriting custom fields', async () => {
    const dir = mkRepo({
      'prisma/schema.prisma': 'model User { id String @id }',
      'prisma/migrations/': true,
    });

    await initMigrate({ repoRoot: dir });
    const first = readStackMd(dir);
    first.migrate.envs.dev.command = {
      exec: 'prisma',
      args: ['migrate', 'deploy', '--my-flag'],
    };
    fs.writeFileSync(
      path.join(dir, '.autopilot', 'stack.md'),
      yaml.dump(first),
    );

    const result = await initMigrate({ repoRoot: dir, force: true });
    assert.equal(result.workspaces[0]!.action, 'wrote');

    const second = readStackMd(dir);
    // Force overwrites — back to defaults from rule
    assert.deepEqual(second.migrate.envs.dev.command, {
      exec: 'prisma',
      args: ['migrate', 'dev'],
    });

    fs.rmSync(dir, { recursive: true });
  });

  it('monorepo with 2 workspaces (Prisma + Drizzle) writes 2 stack.md files + root manifest.yaml', async () => {
    const dir = mkRepo({
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
      }),
      'packages/db-prisma/prisma/schema.prisma':
        'model User { id String @id }',
      'packages/db-prisma/prisma/migrations/': true,
      'packages/db-drizzle/drizzle/migrations/': true,
      'packages/db-drizzle/drizzle.config.ts': 'export default {}',
    });

    const result = await initMigrate({ repoRoot: dir });

    assert.equal(result.workspaces.length, 2);
    const skills = result.workspaces.map(w => w.skill).sort();
    assert.deepEqual(skills, ['migrate@1', 'migrate@1']);

    const prismaStack = readStackMd(path.join(dir, 'packages/db-prisma'));
    const drizzleStack = readStackMd(path.join(dir, 'packages/db-drizzle'));
    assert.deepEqual(prismaStack.migrate.envs.dev.command, {
      exec: 'prisma',
      args: ['migrate', 'dev'],
    });
    assert.deepEqual(drizzleStack.migrate.envs.dev.command, {
      exec: 'drizzle-kit',
      args: ['migrate'],
    });

    // Root manifest exists
    const manifestPath = path.join(dir, '.autopilot', 'manifest.yaml');
    assert.ok(fs.existsSync(manifestPath), 'expected root manifest.yaml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as any;
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.workspaces.length, 2);
    const ws = manifest.workspaces.map((w: any) => w.path).sort();
    assert.deepEqual(ws, ['packages/db-drizzle', 'packages/db-prisma']);

    fs.rmSync(dir, { recursive: true });
  });

  it('multi-match scenario calls injected prompter and uses its choice', async () => {
    // Drizzle config without migrations dir → drizzle-push (low)
    // Plus an alembic.ini → medium match
    // Detector returns 2 matches; should prompt.
    const dir = mkRepo({
      'drizzle.config.ts': 'export default {}',
      'alembic.ini': '[alembic]\n',
    });

    let prompterCalled = false;
    let receivedMatches: any[] = [];

    const result = await initMigrate({
      repoRoot: dir,
      prompter: async ({ matches }) => {
        prompterCalled = true;
        receivedMatches = matches;
        // Pick alembic
        const found = matches.find((m: any) => m.rule.stack === 'alembic');
        if (!found) throw new Error('expected alembic match');
        return found;
      },
    });

    assert.equal(prompterCalled, true);
    assert.ok(receivedMatches.length >= 2);
    assert.equal(result.workspaces[0]!.skill, 'migrate@1');

    const stack = readStackMd(dir);
    assert.deepEqual(stack.migrate.envs.dev.command, {
      exec: 'alembic',
      args: ['upgrade', 'head'],
    });

    fs.rmSync(dir, { recursive: true });
  });

  it('default prompter throws when no prompter is injected and prompt is required', async () => {
    const dir = mkRepo({
      'drizzle.config.ts': 'export default {}',
      'alembic.ini': '[alembic]\n',
    });

    await assert.rejects(
      () => initMigrate({ repoRoot: dir }),
      /interactive prompt not available/,
    );

    fs.rmSync(dir, { recursive: true });
  });
});
