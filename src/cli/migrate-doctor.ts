// src/cli/migrate-doctor.ts
//
// CLI wrapper for migrate doctor checks (Task 7.2).
//
// runMigrateDoctor({ repoRoot, fix? }):
//
//   fix = false (default, "plain doctor")
//     - calls runAllChecks
//     - returns the named results unchanged
//     - NEVER writes to disk (asserted by golden-file test)
//
//   fix = true ("doctor --fix")
//     - runs the same checks
//     - applies AUTO-FIXABLE mutations to .autopilot/stack.md:
//       a) top-level `dev_command` → `migrate.envs.dev.command`
//       b) missing `schema_version: 1`
//       c) raw `migrate.skill` → stable ID (via resolveSkill)
//       d) missing default policy keys backfilled (per skill shape)
//     - writes the updated YAML, then re-runs the checks and returns
//       both the post-fix results and the list of mutations performed
//
// Spec: docs/superpowers/specs/2026-04-29-migrate-skill-generalization-design.md
// (§ "claude-autopilot doctor")

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runAllChecks, type NamedCheckResult } from '../core/migrate/doctor-checks.ts';
import { resolveSkill } from '../core/migrate/alias-resolver.ts';

export interface RunMigrateDoctorOptions {
  repoRoot: string;
  fix?: boolean;
}

export interface RunMigrateDoctorResult {
  allOk: boolean;
  results: NamedCheckResult[];
  /** Populated only when fix=true. Empty if no fixes were needed. */
  mutations?: string[];
}

const DEFAULT_POLICY_GENERIC = {
  allow_prod_in_ci: false,
  require_clean_git: true,
  require_manual_approval: true,
  require_dry_run_first: false,
};

const DEFAULT_POLICY_SUPABASE = {
  allow_prod_in_ci: false,
};

interface StackMd {
  schema_version?: number;
  migrate?: {
    skill?: string;
    project_root?: string;
    envs?: Record<string, { command?: unknown; env_file?: string }>;
    policy?: Record<string, unknown>;
    supabase?: Record<string, string>;
    [k: string]: unknown;
  };
  dev_command?: unknown;
  [k: string]: unknown;
}

function stackPath(repoRoot: string): string {
  return path.join(repoRoot, '.autopilot', 'stack.md');
}

function applyAutoFixes(
  repoRoot: string,
): { mutations: string[]; wrote: boolean } {
  const sp = stackPath(repoRoot);
  if (!fs.existsSync(sp)) {
    return { mutations: [], wrote: false };
  }
  const raw = fs.readFileSync(sp, 'utf8');
  let parsed: StackMd;
  try {
    const loaded = yaml.load(raw);
    if (!loaded || typeof loaded !== 'object') {
      return { mutations: [], wrote: false };
    }
    parsed = loaded as StackMd;
  } catch {
    return { mutations: [], wrote: false };
  }

  const mutations: string[] = [];

  // a) Migrate top-level dev_command → migrate.envs.dev.command
  if ('dev_command' in parsed) {
    const legacy = parsed.dev_command;
    parsed.migrate = parsed.migrate ?? {};
    parsed.migrate.envs = parsed.migrate.envs ?? {};
    if (!parsed.migrate.envs.dev?.command) {
      parsed.migrate.envs.dev = parsed.migrate.envs.dev ?? {};
      parsed.migrate.envs.dev.command = legacy;
      mutations.push('migrated top-level dev_command → migrate.envs.dev.command');
    } else {
      mutations.push('removed redundant top-level dev_command (envs.dev.command already set)');
    }
    delete parsed.dev_command;
  }

  // b) Backfill schema_version
  if (parsed.schema_version === undefined) {
    parsed.schema_version = 1;
    mutations.push('added schema_version: 1');
  }

  // c) Normalize raw skill → stable ID
  const skill = parsed.migrate?.skill;
  if (typeof skill === 'string') {
    const res = resolveSkill(skill, { repoRoot });
    if (res.ok && res.normalizedFromRaw && res.stableId !== skill) {
      parsed.migrate!.skill = res.stableId;
      mutations.push(`normalized migrate.skill: "${skill}" → "${res.stableId}"`);
    }
  }

  // d) Backfill missing default policy keys based on resolved skill shape
  if (parsed.migrate) {
    const resolvedSkill = parsed.migrate.skill;
    let defaults: Record<string, boolean> | null = null;
    if (resolvedSkill === 'migrate@1') defaults = DEFAULT_POLICY_GENERIC;
    else if (resolvedSkill === 'migrate.supabase@1') defaults = DEFAULT_POLICY_SUPABASE;
    if (defaults) {
      const policy = (parsed.migrate.policy ?? {}) as Record<string, unknown>;
      const added: string[] = [];
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in policy)) {
          policy[k] = v;
          added.push(k);
        }
      }
      if (added.length > 0) {
        parsed.migrate.policy = policy;
        mutations.push(`backfilled default policy keys: ${added.join(', ')}`);
      }
    }
  }

  if (mutations.length === 0) {
    return { mutations, wrote: false };
  }

  fs.writeFileSync(sp, yaml.dump(parsed, { lineWidth: 120, noRefs: true }), 'utf8');
  return { mutations, wrote: true };
}

export async function runMigrateDoctor(
  opts: RunMigrateDoctorOptions,
): Promise<RunMigrateDoctorResult> {
  const repoRoot = path.resolve(opts.repoRoot);
  const fix = opts.fix ?? false;

  if (!fix) {
    // Plain doctor: read-only.
    const results = runAllChecks(repoRoot);
    return { allOk: results.every(r => r.result.ok), results };
  }

  // --fix: apply auto-fixable mutations, then re-run checks.
  const { mutations } = applyAutoFixes(repoRoot);
  const results = runAllChecks(repoRoot);
  return {
    allOk: results.every(r => r.result.ok),
    results,
    mutations,
  };
}
