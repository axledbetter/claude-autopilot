import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SchemaEntity, Evidence, LayerScanResult, SchemaAlignmentConfig } from './types.ts';

const DEFAULT_ROOTS = {
  types: ['types/', 'src/types/', 'lib/types/'],
  api: ['app/api/', 'lib/', 'services/', 'src/routes/'],
  ui: ['app/', 'src/', 'components/'],
};

function* walkFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walkFiles(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTS.has(ext)) yield path.join(dir, entry.name);
    }
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', 'coverage', '.git',
  '.turbo', '.cache', '.vercel', 'out', '.nuxt', 'target',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs',
]);

function resolveRoots(roots: string[], cwd: string): string[] {
  return roots.map(r => path.isAbsolute(r) ? r : path.join(cwd, r));
}

function isUnder(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function searchLayer(
  roots: string[],
  pattern: RegExp,
  cwd: string,
  excludedDirs: string[] = [],
): Evidence | null {
  for (const root of roots) {
    const dir = path.isAbsolute(root) ? root : path.join(cwd, root);
    for (const filePath of walkFiles(dir)) {
      // Skip files that belong to an excluded layer's root (avoids UI root
      // `app/` reporting API evidence from `app/api/`, etc.)
      if (excludedDirs.some(excl => isUnder(filePath, excl))) continue;
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i]!)) {
          return {
            file: filePath,
            line: i + 1,
            snippet: lines[i]!.trim().slice(0, 120),
            confidence: 'high',
          };
        }
      }
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanLayers(
  entities: SchemaEntity[],
  cwd: string,
  config?: SchemaAlignmentConfig,
): LayerScanResult[] {
  const roots = {
    types: config?.layerRoots?.types ?? DEFAULT_ROOTS.types,
    api: config?.layerRoots?.api ?? DEFAULT_ROOTS.api,
    ui: config?.layerRoots?.ui ?? DEFAULT_ROOTS.ui,
  };
  const resolvedTypeRoots = resolveRoots(roots.types, cwd);
  const resolvedApiRoots = resolveRoots(roots.api, cwd);

  return entities.map(entity => {
    const isDestructive = entity.operation === 'drop_column' || entity.operation === 'rename_column';
    const searchName = isDestructive
      ? (entity.oldName ?? entity.column ?? entity.table)
      : (entity.column ?? entity.table);

    const pattern = new RegExp(`\\b${escapeRe(searchName)}\\b`);

    return {
      entity,
      typeLayer: searchLayer(roots.types, pattern, cwd),
      // API search excludes type roots (prevents lib/ from picking up lib/types/ matches)
      apiLayer: searchLayer(roots.api, pattern, cwd, resolvedTypeRoots),
      // UI search excludes both type and API roots (prevents app/ from picking up app/api/)
      uiLayer: searchLayer(roots.ui, pattern, cwd, [...resolvedTypeRoots, ...resolvedApiRoots]),
    };
  });
}
