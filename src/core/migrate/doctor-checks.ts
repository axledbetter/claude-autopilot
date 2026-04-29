// src/core/migrate/doctor-checks.ts
//
// Pure check functions for `claude-autopilot doctor` (migrate-specific).
// Each check is read-only and returns { ok, message?, fixHint? }.
// Mutations live behind `--fix` (see src/cli/migrate-doctor.ts).
//
// Spec: docs/superpowers/specs/2026-04-29-migrate-skill-generalization-design.md
// (§ "claude-autopilot doctor", checks 1–8)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { validateStackMd } from './schema-validator.ts';
import { resolveSkill } from './alias-resolver.ts';
import { DETECTION_RULES, type DetectionRule } from './detector-rules.ts';

export interface CheckResult {
  ok: boolean;
  message?: string;
  fixHint?: string;
}

export interface NamedCheckResult {
  name: string;
  result: CheckResult;
}

interface StackMd {
  schema_version?: number;
  migrate?: {
    skill?: string;
    project_root?: string;
    envs?: Record<string, { command?: unknown; env_file?: string }>;
    policy?: Record<string, unknown>;
    supabase?: { deltas_dir?: string; types_out?: string; envs_file?: string };
    [k: string]: unknown;
  };
  /** Legacy top-level alias for envs.dev.command. */
  dev_command?: unknown;
  [k: string]: unknown;
}

function stackPath(repoRoot: string): string {
  return path.join(repoRoot, '.autopilot', 'stack.md');
}

function readStackMdRaw(repoRoot: string): { raw: string; parsed: StackMd } | null {
  const p = stackPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return { raw, parsed: parsed as StackMd };
}

// 1. stack.md exists
export function stackMdExists(repoRoot: string): CheckResult {
  const p = stackPath(repoRoot);
  if (fs.existsSync(p)) return { ok: true };
  return {
    ok: false,
    message: `.autopilot/stack.md not found in ${repoRoot}`,
    fixHint: 'run `claude-autopilot init` to scaffold one',
  };
}

// 2. JSON Schema validates
export function schemaValidates(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return {
      ok: false,
      message: 'cannot validate schema: stack.md missing or unparseable',
      fixHint: 'run `claude-autopilot init`',
    };
  }
  const result = validateStackMd(data.raw);
  if (result.valid) return { ok: true };
  const summary = result.errors
    .map(e => (e.path ? `${e.path}: ${e.message}` : e.message))
    .join('; ');
  return {
    ok: false,
    message: `schema validation failed — ${summary}`,
    fixHint: 'run `claude-autopilot doctor --fix` to auto-fix simple cases (missing schema_version, default policy keys)',
  };
}

// 3. migrate.skill resolves to an installed skill
export function skillResolves(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot resolve skill: stack.md missing' };
  }
  const skill = data.parsed.migrate?.skill;
  if (!skill || typeof skill !== 'string') {
    return {
      ok: false,
      message: 'migrate.skill is missing or not a string',
      fixHint: 'set `migrate.skill` to a stable ID (e.g. "migrate@1", "migrate.supabase@1", "none@1")',
    };
  }
  const res = resolveSkill(skill, { repoRoot });
  if (res.ok) {
    if (res.normalizedFromRaw) {
      return {
        ok: false,
        message: `migrate.skill "${skill}" is a raw alias; resolves to stable ID "${res.stableId}"`,
        fixHint: `change \`migrate.skill\` to "${res.stableId}" (auto-fixable via --fix)`,
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    message: `migrate.skill "${skill}" failed to resolve: ${res.message}`,
    fixHint: 'use a stable ID listed in presets/aliases.lock.json',
  };
}

// 4. Per-env commands explicit (no env reuses envs.dev.command)
export function perEnvCommandsExplicit(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot check envs: stack.md missing' };
  }
  const envs = data.parsed.migrate?.envs;
  if (!envs) return { ok: true };
  const dev = envs.dev?.command;
  if (!dev) return { ok: true };
  const devKey = JSON.stringify(dev);
  const offenders: string[] = [];
  for (const [name, spec] of Object.entries(envs)) {
    if (name === 'dev') continue;
    if (spec?.command && JSON.stringify(spec.command) === devKey) {
      offenders.push(name);
    }
  }
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    message: `envs.${offenders.join(', envs.')} reuse envs.dev.command — running a dev migration against a non-dev env is destructive`,
    fixHint: `set an explicit \`command\` for each non-dev env (e.g. \`prisma migrate deploy\` for prod)`,
  };
}

// 5. policy.* fields are booleans
export function policyFieldsValid(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot check policy: stack.md missing' };
  }
  const policy = data.parsed.migrate?.policy;
  if (!policy || typeof policy !== 'object') return { ok: true };
  const offenders: string[] = [];
  for (const [k, v] of Object.entries(policy)) {
    if (typeof v !== 'boolean') {
      offenders.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    message: `policy fields must be booleans; offenders: ${offenders.join(', ')}`,
    fixHint: 'edit `.autopilot/stack.md` so each policy.* field is `true` or `false`',
  };
}

function findRuleForSkill(skill: string): DetectionRule | undefined {
  // Match by defaultSkill. For migrate@1 there are many rules; we
  // can't disambiguate without re-detecting, so we only verify
  // narrow skill IDs (migrate.supabase@1) and return undefined for
  // generic migrate@1 (which can have any toolchain).
  return DETECTION_RULES.find(r => r.defaultSkill === skill);
}

// 6. project_root has expected toolchain files for the resolved skill.
export function projectRootHasToolchain(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot verify toolchain: stack.md missing' };
  }
  const skill = data.parsed.migrate?.skill;
  if (!skill) return { ok: false, message: 'migrate.skill is missing' };

  // Skip the no-op skill — nothing to verify.
  if (skill === 'none@1') return { ok: true };

  const projectRoot = data.parsed.migrate?.project_root ?? '.';
  const projectAbs = path.resolve(repoRoot, projectRoot);
  if (!fs.existsSync(projectAbs)) {
    return {
      ok: false,
      message: `project_root "${projectRoot}" does not exist (resolved: ${projectAbs})`,
      fixHint: 'set `migrate.project_root` to a path that exists, or run `init`',
    };
  }

  // Rule-based toolchain check. For migrate.supabase@1 there's exactly
  // one matching rule (nextjs-supabase). For migrate@1, multiple rules
  // share the skill; we only enforce the toolchain when stack.md
  // explicitly declares a supabase or shape-narrowed skill.
  if (skill === 'migrate.supabase@1') {
    const rule = DETECTION_RULES.find(r => r.defaultSkill === 'migrate.supabase@1');
    if (!rule) return { ok: true };
    const missing = rule.requireAll.filter(p => !fs.existsSync(path.join(projectAbs, p)));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `project_root missing expected toolchain files for ${skill}: ${missing.join(', ')}`,
      fixHint: 'verify `migrate.project_root` points to the correct workspace',
    };
  }

  // For migrate@1, attempt best-effort detection via existing rules to
  // catch obvious misalignments. We require AT LEAST one migrate@1 rule
  // to satisfy its requireAll/requireAny set; if none do, the stack.md
  // claims a tool that isn't present.
  if (skill === 'migrate@1') {
    const candidates = DETECTION_RULES.filter(r => r.defaultSkill === 'migrate@1');
    const anySatisfied = candidates.some(r => {
      const allOk = r.requireAll.every(p => fs.existsSync(path.join(projectAbs, p)));
      const anyOk = !r.requireAny || r.requireAny.some(p => fs.existsSync(path.join(projectAbs, p)));
      return allOk && anyOk && r.requireAll.length + (r.requireAny?.length ?? 0) > 0;
    });
    if (anySatisfied) return { ok: true };
    return {
      ok: false,
      message: `project_root "${projectRoot}" does not contain any recognized migration toolchain files for ${skill}`,
      fixHint: 'verify `migrate.project_root` or change `migrate.skill` to match your stack',
    };
  }

  // Unknown skill — let skillResolves report the issue.
  const rule = findRuleForSkill(skill);
  if (!rule) return { ok: true };
  return { ok: true };
}

// 7. Deprecated keys reported (read-only).
export function deprecatedKeysAbsent(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot check deprecated keys: stack.md missing' };
  }
  const offenders: string[] = [];
  if ('dev_command' in data.parsed) {
    offenders.push('dev_command (top-level)');
  }
  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    message: `deprecated keys present: ${offenders.join(', ')}`,
    fixHint: 'run `claude-autopilot doctor --fix` to migrate `dev_command` → `migrate.envs.dev.command`',
  };
}

// 8. env_file safety: relative to project_root, no `..`, NOT git-tracked.
export function envFileSafety(repoRoot: string): CheckResult {
  const data = readStackMdRaw(repoRoot);
  if (!data) {
    return { ok: false, message: 'cannot check env_file: stack.md missing' };
  }
  const envs = data.parsed.migrate?.envs;
  if (!envs) return { ok: true };
  const projectRoot = data.parsed.migrate?.project_root ?? '.';
  const projectAbs = path.resolve(repoRoot, projectRoot);

  const issues: string[] = [];
  for (const [name, spec] of Object.entries(envs)) {
    const ef = spec?.env_file;
    if (!ef) continue;
    if (path.isAbsolute(ef)) {
      issues.push(`envs.${name}.env_file is absolute (${ef}); must be relative to project_root`);
      continue;
    }
    const segments = ef.split(/[/\\]/);
    if (segments.some(s => s === '..')) {
      issues.push(`envs.${name}.env_file contains ".." traversal (${ef}); reject for safety`);
      continue;
    }
    const efAbs = path.resolve(projectAbs, ef);
    const rel = path.relative(projectAbs, efAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      issues.push(`envs.${name}.env_file resolves outside project_root (${ef})`);
      continue;
    }
    // Existence is not required (the env file may live only on the
    // operator's machine), but if the repo is a git repo and the file
    // IS tracked, that's a leak we must warn about.
    try {
      const out = execFileSync(
        'git',
        ['ls-files', '--error-unmatch', '--', ef],
        { cwd: projectAbs, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim();
      if (out) {
        issues.push(`envs.${name}.env_file is git-tracked (${ef}); secrets in env files must be gitignored`);
      }
    } catch {
      // Not tracked, or not a git repo — both are fine for the safety
      // check. Doctor surfaces tracked files only.
    }
  }
  if (issues.length === 0) return { ok: true };
  return {
    ok: false,
    message: issues.join('; '),
    fixHint: 'remove the offending env_file from git (`git rm --cached <file>`) and add it to .gitignore',
  };
}

export function runAllChecks(repoRoot: string): NamedCheckResult[] {
  return [
    { name: 'stackMdExists', result: stackMdExists(repoRoot) },
    { name: 'schemaValidates', result: schemaValidates(repoRoot) },
    { name: 'skillResolves', result: skillResolves(repoRoot) },
    { name: 'perEnvCommandsExplicit', result: perEnvCommandsExplicit(repoRoot) },
    { name: 'policyFieldsValid', result: policyFieldsValid(repoRoot) },
    { name: 'projectRootHasToolchain', result: projectRootHasToolchain(repoRoot) },
    { name: 'deprecatedKeysAbsent', result: deprecatedKeysAbsent(repoRoot) },
    { name: 'envFileSafety', result: envFileSafety(repoRoot) },
  ];
}
