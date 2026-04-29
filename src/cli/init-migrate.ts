// src/cli/init-migrate.ts
//
// Init flow extension for the migrate skill. Walks workspaces, runs
// detection per workspace, and writes a per-workspace
// `<workspace>/.autopilot/stack.md` (plus a root `<repoRoot>/.autopilot/
// manifest.yaml` for monorepos).
//
// Decision tree per workspace:
//   - --skipMigrate: write `migrate.skill: "none@1"` shape with TODO
//   - autoSelect (1 high-confidence match): write the rule's defaults
//   - prompt required (>1 match or non-high): call injected prompter
//   - zero matches: throw NoMigrationToolDetectedError
//
// Idempotent: existing stack.md is loaded and merged. User-edited fields
// (envs.*.command, custom env_file, etc.) are preserved; only
// `detected_at` is refreshed and missing default policy keys are added.
// `force: true` regenerates from scratch.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { detect, type DetectionMatch } from '../core/migrate/detector.ts';
import { findWorkspaces } from '../core/migrate/monorepo.ts';
import type { DetectionRule } from '../core/migrate/detector-rules.ts';
import type { CommandSpec } from '../core/migrate/types.ts';

export class NoMigrationToolDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoMigrationToolDetectedError';
  }
}

export interface PrompterArgs {
  workspace: string;
  matches: DetectionMatch[];
}

export type Prompter = (args: PrompterArgs) => Promise<DetectionMatch>;

export interface InitMigrateOptions {
  repoRoot: string;
  skipMigrate?: boolean;
  force?: boolean;
  /**
   * When true, computes what would be written but performs no write.
   * Each workspace result includes a `diff` field showing the
   * proposed change against the existing stack.md (or "would create
   * new file" if missing). Used by `--force-rewrite` to preview
   * changes before user confirmation.
   */
  dryRunPreview?: boolean;
  prompter?: Prompter;
}

export interface WorkspaceResult {
  workspace: string;
  action: 'wrote' | 'updated' | 'skipped' | 'preview';
  skill: string;
  /** Populated only when dryRunPreview is true. */
  diff?: string;
}

export interface InitMigrateResult {
  workspaces: WorkspaceResult[];
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

const DEFAULT_PROMPTER: Prompter = async () => {
  throw new Error(
    'interactive prompt not available — pass `prompter` in initMigrate options or run with --skip-migrate',
  );
};

interface StackMdShape {
  schema_version: number;
  migrate: {
    skill: string;
    envs?: Record<
      string,
      { command?: CommandSpec | string; env_file?: string }
    >;
    supabase?: { deltas_dir: string; types_out: string; envs_file: string };
    policy?: Record<string, boolean>;
    detected_at?: string;
    project_root?: string;
    [key: string]: unknown;
  };
}

function buildFreshStack(
  rule: DetectionRule,
  skipMigrate: boolean,
): StackMdShape {
  const detectedAt = new Date().toISOString();

  if (skipMigrate) {
    return {
      schema_version: 1,
      migrate: {
        skill: 'none@1',
        detected_at: detectedAt,
        project_root: '.',
      },
    };
  }

  if (rule.defaultSkill === 'migrate.supabase@1') {
    return {
      schema_version: 1,
      migrate: {
        skill: 'migrate.supabase@1',
        supabase: {
          deltas_dir: 'data/deltas',
          types_out: 'types/supabase.ts',
          envs_file: '.claude/supabase-envs.json',
        },
        policy: { ...DEFAULT_POLICY_SUPABASE },
        detected_at: detectedAt,
        project_root: '.',
      },
    };
  }

  // Generic migrate@1 shape
  const stack: StackMdShape = {
    schema_version: 1,
    migrate: {
      skill: 'migrate@1',
      policy: { ...DEFAULT_POLICY_GENERIC },
      detected_at: detectedAt,
      project_root: '.',
    },
  };
  if (rule.defaultCommand) {
    stack.migrate.envs = {
      dev: { command: { ...rule.defaultCommand, args: [...rule.defaultCommand.args] } },
    };
  } else {
    // No default command in the rule; init still writes envs.dev as a
    // placeholder so schema validates. User is expected to fill it in.
    stack.migrate.envs = {
      dev: { command: { exec: 'TODO', args: ['configure-dev-command'] } },
    };
  }
  return stack;
}

function mergePreserving(
  existing: StackMdShape,
  fresh: StackMdShape,
): StackMdShape {
  // Preserve all user fields; only update detected_at and add missing
  // defaults (schema_version, missing policy keys, project_root).
  const merged: StackMdShape = {
    schema_version: existing.schema_version ?? fresh.schema_version,
    migrate: { ...existing.migrate },
  };

  // Always refresh detected_at
  merged.migrate.detected_at = fresh.migrate.detected_at;

  // Backfill project_root if missing
  if (!merged.migrate.project_root && fresh.migrate.project_root) {
    merged.migrate.project_root = fresh.migrate.project_root;
  }

  // Merge missing default policy keys (do not overwrite user-set keys)
  if (fresh.migrate.policy) {
    const existingPolicy = (merged.migrate.policy ?? {}) as Record<
      string,
      boolean
    >;
    const mergedPolicy: Record<string, boolean> = { ...existingPolicy };
    for (const [k, v] of Object.entries(fresh.migrate.policy)) {
      if (!(k in mergedPolicy)) mergedPolicy[k] = v;
    }
    merged.migrate.policy = mergedPolicy;
  }

  // Backfill supabase block if missing (preserve user values otherwise)
  if (fresh.migrate.supabase && !merged.migrate.supabase) {
    merged.migrate.supabase = { ...fresh.migrate.supabase };
  }

  // Backfill envs.dev if missing (preserve user-set commands otherwise)
  if (fresh.migrate.envs?.dev && !merged.migrate.envs) {
    merged.migrate.envs = {
      dev: { ...fresh.migrate.envs.dev },
    };
  } else if (fresh.migrate.envs?.dev && merged.migrate.envs && !merged.migrate.envs.dev) {
    merged.migrate.envs.dev = { ...fresh.migrate.envs.dev };
  }

  return merged;
}

function readExistingStackMd(stackPath: string): StackMdShape | null {
  try {
    const content = fs.readFileSync(stackPath, 'utf8');
    const parsed = yaml.load(content) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'migrate' in parsed
    ) {
      return parsed as StackMdShape;
    }
    return null;
  } catch {
    return null;
  }
}

function serializeStackMd(stack: StackMdShape, options: { skipMigrate: boolean }): string {
  // YAML body
  const body = yaml.dump(stack, { lineWidth: 120, noRefs: true });
  if (options.skipMigrate) {
    return (
      body +
      '# TODO: configure your migration tool. See docs/skills/rich-migrate-contract.md\n'
    );
  }
  return body;
}

/**
 * Produce a unified-diff-style summary of the change from `oldText` to
 * `newText`. Pure-line LCS — no external dependency. Output is for human
 * review only; not intended to round-trip via `patch`.
 */
function unifiedDiff(oldText: string, newText: string): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;

  // LCS table
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) {
    out.push(`- ${a[i]}`);
    i++;
  }
  while (j < n) {
    out.push(`+ ${b[j]}`);
    j++;
  }
  return out.join('\n');
}

function chooseRule(
  matches: DetectionMatch[],
  autoSelect: boolean,
  prompter: Prompter,
  workspace: string,
): Promise<DetectionMatch> {
  if (autoSelect) return Promise.resolve(matches[0]!);
  return prompter({ workspace, matches });
}

export async function initMigrate(
  opts: InitMigrateOptions,
): Promise<InitMigrateResult> {
  const repoRoot = path.resolve(opts.repoRoot);
  const skipMigrate = opts.skipMigrate ?? false;
  const force = opts.force ?? false;
  const dryRunPreview = opts.dryRunPreview ?? false;
  const prompter = opts.prompter ?? DEFAULT_PROMPTER;

  const workspaces = findWorkspaces(repoRoot);
  const results: WorkspaceResult[] = [];

  for (const workspace of workspaces) {
    const stackDir = path.join(workspace, '.autopilot');
    const stackPath = path.join(stackDir, 'stack.md');
    const exists = fs.existsSync(stackPath);

    let chosenRule: DetectionRule | null = null;

    if (!skipMigrate) {
      const det = detect(workspace);
      if (det.matches.length === 0) {
        throw new NoMigrationToolDetectedError(
          `No migration tool detected in ${workspace}. Re-run with --skip-migrate to write a 'none@1' stack.md and configure later.`,
        );
      }
      const chosen = await chooseRule(
        det.matches,
        det.autoSelect,
        prompter,
        workspace,
      );
      chosenRule = chosen.rule;
    }

    // For skipMigrate, chosenRule stays null — buildFreshStack ignores it.
    const fresh = buildFreshStack(
      chosenRule ?? ({} as DetectionRule),
      skipMigrate,
    );

    let toWrite: StackMdShape;
    let action: WorkspaceResult['action'];

    if (dryRunPreview) {
      // Preview always reflects the *fresh* content (mirrors `force: true`).
      // Merge-preserving previews can be added later if needed.
      toWrite = fresh;
      action = 'preview';
    } else if (exists && !force) {
      const existing = readExistingStackMd(stackPath);
      if (existing) {
        toWrite = mergePreserving(existing, fresh);
        action = 'updated';
      } else {
        toWrite = fresh;
        action = 'wrote';
      }
    } else {
      toWrite = fresh;
      action = 'wrote';
    }

    const newContent = serializeStackMd(toWrite, { skipMigrate });

    if (dryRunPreview) {
      // Compute diff against existing on disk; do NOT write.
      const oldContent = exists ? fs.readFileSync(stackPath, 'utf8') : '';
      const diff = exists
        ? unifiedDiff(oldContent, newContent)
        : `would create new file ${path.relative(repoRoot, stackPath) || stackPath}\n${newContent
            .split('\n')
            .map(l => `+ ${l}`)
            .join('\n')}`;
      results.push({
        workspace,
        action,
        skill: toWrite.migrate.skill,
        diff,
      });
      continue;
    }

    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(stackPath, newContent, 'utf8');

    results.push({
      workspace,
      action,
      skill: toWrite.migrate.skill,
    });
  }

  // Multi-workspace repos: write a root manifest.yaml listing the workspaces.
  if (workspaces.length > 1 && !dryRunPreview) {
    const manifestDir = path.join(repoRoot, '.autopilot');
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = {
      schema_version: 1,
      workspaces: results.map(r => ({
        path: path.relative(repoRoot, r.workspace) || '.',
        skill: r.skill,
      })),
    };
    fs.writeFileSync(
      path.join(manifestDir, 'manifest.yaml'),
      yaml.dump(manifest, { lineWidth: 120, noRefs: true }),
      'utf8',
    );
  }

  return { workspaces: results };
}
