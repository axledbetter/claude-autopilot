// src/core/migrate/policy-enforcer.ts
//
// Enforces migrate.policy.* fields plus the dispatcher-level CI prod
// safety floor (4 flags + recognized CI provider). Skills cannot relax
// these checks. Failures return reasonCode + checklist message.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectCI } from './envelope.ts';

export interface PolicyConfig {
  allow_prod_in_ci: boolean;
  require_clean_git: boolean;
  require_manual_approval: boolean;
  require_dry_run_first: boolean;
}

export interface EnforcementContext {
  policy: PolicyConfig;
  env: string;
  repoRoot: string;
  ci: boolean;
  yesFlag: boolean;
  nonInteractive: boolean;
  gitHead: string;
  /** When set, override AUTOPILOT_TARGET_ENV check with this value (mainly for tests) */
  _targetEnvOverride?: string;
}

export type EnforcementResult =
  | { ok: true; decisions: string[] }
  | { ok: false; reasonCode: string; message: string; decisions: string[] };

export function enforcePolicy(ctx: EnforcementContext): EnforcementResult {
  const decisions: string[] = [];
  const isProdLike = ctx.env !== 'dev';

  // 1. CI prod gate (only relevant for non-dev in CI)
  if (isProdLike && ctx.ci) {
    if (!ctx.policy.allow_prod_in_ci) {
      decisions.push(`allow_prod_in_ci=false`);
      return {
        ok: false,
        reasonCode: 'prod-blocked-by-policy',
        message: `migrate.policy.allow_prod_in_ci is false. To run --env ${ctx.env} in CI:\n  1) Set migrate.policy.allow_prod_in_ci: true in stack.md\n  2) Pass --yes flag\n  3) Set AUTOPILOT_CI_POLICY=allow-prod\n  4) Set AUTOPILOT_TARGET_ENV=${ctx.env}`,
        decisions,
      };
    }
    if (!ctx.yesFlag) {
      decisions.push(`yes-flag=missing`);
      return { ok: false, reasonCode: 'yes-flag-missing', message: '--yes flag required for non-dev env in CI', decisions };
    }
    if (process.env.AUTOPILOT_CI_POLICY !== 'allow-prod') {
      decisions.push(`AUTOPILOT_CI_POLICY=missing`);
      return { ok: false, reasonCode: 'ci-policy-missing', message: 'AUTOPILOT_CI_POLICY=allow-prod env var required for non-dev env in CI', decisions };
    }
    const targetEnv = process.env.AUTOPILOT_TARGET_ENV;
    if (targetEnv !== ctx.env) {
      decisions.push(`AUTOPILOT_TARGET_ENV=${targetEnv ?? 'unset'} expected ${ctx.env}`);
      return { ok: false, reasonCode: 'target-env-mismatch', message: `AUTOPILOT_TARGET_ENV must equal --env (${ctx.env})`, decisions };
    }
    const ciInfo = detectCI();
    if (!ciInfo.provider) {
      decisions.push(`ci-provider=unrecognized`);
      return {
        ok: false,
        reasonCode: 'no-recognized-ci-provider',
        message: 'No recognized CI provider env detected. Set AUTOPILOT_CI_PROVIDER=<name> for self-hosted CI.',
        decisions,
      };
    }
    decisions.push(`ci-provider=${ciInfo.provider}${ciInfo.overridden ? '(override)' : ''}`);
  }

  // 2. require_clean_git
  if (ctx.policy.require_clean_git) {
    let dirty = false;
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: ctx.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      dirty = out.trim().length > 0;
    } catch {
      // not a git repo or other failure → treat as dirty (fail closed)
      dirty = true;
    }
    if (dirty) {
      decisions.push(`require_clean_git=failed`);
      return {
        ok: false,
        reasonCode: 'unclean-git',
        message: 'Working tree has uncommitted changes. Commit, stash, or reset before running migrate.',
        decisions,
      };
    }
    decisions.push(`require_clean_git=passed`);
  }

  // 3. require_manual_approval (only relevant for non-dev, non-CI interactive)
  if (isProdLike && !ctx.ci && ctx.policy.require_manual_approval) {
    if (ctx.yesFlag) {
      decisions.push(`manual_approval=skipped(--yes)`);
    } else if (ctx.nonInteractive) {
      decisions.push(`manual_approval=blocked(non-interactive)`);
      return {
        ok: false,
        reasonCode: 'manual-approval-required',
        message: `Non-dev env (${ctx.env}) requires interactive approval. Pass --yes to skip.`,
        decisions,
      };
    } else {
      // Interactive prompt would go here; for now we treat as approved if interactive (the dispatcher
      // is responsible for prompting before calling enforcePolicy in interactive mode).
      decisions.push(`manual_approval=interactive`);
    }
  }

  // 4. require_dry_run_first
  if (ctx.policy.require_dry_run_first && isProdLike) {
    const dryRunPath = path.join(ctx.repoRoot, '.autopilot', 'dry-runs', `${ctx.gitHead}-${ctx.env}.json`);
    if (!fs.existsSync(dryRunPath)) {
      decisions.push(`require_dry_run_first=failed`);
      return {
        ok: false,
        reasonCode: 'no-prior-dry-run',
        message: `require_dry_run_first=true and no dry-run artifact at ${dryRunPath}. Run with --dry-run first.`,
        decisions,
      };
    }
    decisions.push(`require_dry_run_first=passed`);
  }

  return { ok: true, decisions };
}
