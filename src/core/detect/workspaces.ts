import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Workspace {
  name: string;
  dir: string;          // absolute path
  rel: string;          // relative to root
  testCommand?: string;
}

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function globDirs(root: string, patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    // Support "packages/*" and "apps/*" style globs (one level deep only)
    const parts = pattern.split('/');
    if (parts.length === 2 && parts[1] === '*') {
      const base = path.join(root, parts[0]!);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) results.push(path.join(base, entry.name));
      }
    } else {
      const abs = path.join(root, pattern);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) results.push(abs);
    }
  }
  return results;
}

function detectTestCommand(dir: string): string | undefined {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg?.scripts && typeof (pkg.scripts as Record<string, unknown>).test === 'string') {
    return `npm test --prefix ${dir}`;
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) return `go test ./... -C ${dir}`;
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return `cargo test --manifest-path ${path.join(dir, 'Cargo.toml')}`;
  return undefined;
}

/** Detect npm/yarn/pnpm workspaces, Turborepo, Nx, Go multi-module. */
export function detectWorkspaces(cwd: string): Workspace[] | null {
  const pkg = readJson(path.join(cwd, 'package.json')) as { workspaces?: string[] | { packages?: string[] }; name?: string } | null;

  // npm/yarn workspaces
  let wsDirs: string[] = [];
  if (pkg?.workspaces) {
    const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
    wsDirs = globDirs(cwd, patterns);
  }

  // Turborepo — pnpm-workspace.yaml or turbo.json
  if (wsDirs.length === 0 && fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    try {
      const raw = fs.readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
      const matches = raw.match(/^\s*-\s*['"]?([^'"#\n]+)['"]?/gm) ?? [];
      const patterns = matches.map(m => m.replace(/^\s*-\s*['"]?/, '').replace(/['"]?\s*$/, '').trim());
      wsDirs = globDirs(cwd, patterns);
    } catch { /* ignore */ }
  }

  // Turborepo fallback: packages/ and apps/ dirs
  if (wsDirs.length === 0 && fs.existsSync(path.join(cwd, 'turbo.json'))) {
    wsDirs = globDirs(cwd, ['packages/*', 'apps/*']);
  }

  // Nx: check nx.json + libs/ + apps/
  if (wsDirs.length === 0 && fs.existsSync(path.join(cwd, 'nx.json'))) {
    wsDirs = globDirs(cwd, ['libs/*', 'apps/*', 'packages/*']);
  }

  if (wsDirs.length === 0) return null;

  return wsDirs
    .filter(d => fs.existsSync(d))
    .map(d => {
      const rel = path.relative(cwd, d);
      const pkgJson = readJson(path.join(d, 'package.json')) as { name?: string } | null;
      return {
        name: pkgJson?.name ?? rel,
        dir: d,
        rel,
        testCommand: detectTestCommand(d),
      };
    });
}

/** Given a list of touched files, return which workspaces they belong to. */
export function mapFilesToWorkspaces(files: string[], workspaces: Workspace[], cwd: string): Map<Workspace, string[]> {
  const result = new Map<Workspace, string[]>();
  for (const file of files) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    const ws = workspaces.find(w => abs.startsWith(w.dir + path.sep) || abs === w.dir);
    if (ws) {
      if (!result.has(ws)) result.set(ws, []);
      result.get(ws)!.push(file);
    }
  }
  return result;
}
