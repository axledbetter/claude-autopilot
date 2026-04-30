// src/core/migrate/monorepo.ts
//
// Discovers monorepo workspaces from common declarations:
// pnpm-workspace.yaml, package.json#workspaces, nx.json. Falls back to
// [repoRoot] for single-workspace repos. Glob patterns expanded
// (packages/*, apps/*).
//
// Workspace paths are filtered to those that actually exist as
// directories AND stay within repoRoot (no path-escape).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

function expandGlob(repoRoot: string, pattern: string): string[] {
  // Only handle simple patterns: 'packages/*', 'apps/*', 'libs/*'
  // (single trailing star). Anything more complex is ignored.
  if (!pattern.includes('*')) {
    const abs = path.resolve(repoRoot, pattern);
    return abs.startsWith(repoRoot) && fs.existsSync(abs) && fs.statSync(abs).isDirectory()
      ? [abs]
      : [];
  }
  const idx = pattern.indexOf('*');
  const prefix = pattern.slice(0, idx).replace(/\/$/, '');
  const baseAbs = path.resolve(repoRoot, prefix);
  if (!baseAbs.startsWith(repoRoot)) return [];
  if (!fs.existsSync(baseAbs)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory())
    .map(e => path.join(baseAbs, e.name));
}

function readPnpmWorkspace(repoRoot: string): string[] | null {
  const p = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(p)) return null;
  try {
    const data = yaml.load(fs.readFileSync(p, 'utf8')) as { packages?: string[] };
    return data?.packages ?? null;
  } catch {
    return null;
  }
}

function readPackageJsonWorkspaces(repoRoot: string): string[] | null {
  const p = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { workspaces?: unknown };
    if (!data.workspaces) return null;
    if (Array.isArray(data.workspaces)) return data.workspaces.filter((w): w is string => typeof w === 'string');
    if (typeof data.workspaces === 'object' && data.workspaces !== null && Array.isArray((data.workspaces as { packages?: unknown }).packages)) {
      return (data.workspaces as { packages: unknown[] }).packages.filter((w): w is string => typeof w === 'string');
    }
    return null;
  } catch {
    return null;
  }
}

function readNxProjects(repoRoot: string): string[] | null {
  const p = path.join(repoRoot, 'nx.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      projects?: Record<string, { root?: string }> | string[];
    };
    if (Array.isArray(data.projects)) return data.projects;
    if (data.projects && typeof data.projects === 'object') {
      return Object.values(data.projects)
        .map(v => v?.root)
        .filter((r): r is string => typeof r === 'string');
    }
    return null;
  } catch {
    return null;
  }
}

export function findWorkspaces(repoRoot: string): string[] {
  // Resolve to absolute path (no symlink follow needed; repoRoot is canonical
  // by caller's contract).
  const repoAbs = path.resolve(repoRoot);

  const patterns =
    readPnpmWorkspace(repoAbs) ??
    readPackageJsonWorkspaces(repoAbs) ??
    readNxProjects(repoAbs);

  if (!patterns || patterns.length === 0) {
    return [repoAbs];
  }

  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const abs of expandGlob(repoAbs, pattern)) {
      // Path-escape guard: must remain under repoAbs
      if (abs.startsWith(repoAbs + path.sep) || abs === repoAbs) {
        found.add(abs);
      }
    }
  }

  if (found.size === 0) {
    return [repoAbs];
  }

  return Array.from(found).sort();
}
