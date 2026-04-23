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

function searchLayer(roots: string[], pattern: RegExp, cwd: string): Evidence | null {
  for (const root of roots) {
    const dir = path.isAbsolute(root) ? root : path.join(cwd, root);
    for (const filePath of walkFiles(dir)) {
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

  return entities.map(entity => {
    const isDestructive = entity.operation === 'drop_column' || entity.operation === 'rename_column';
    // For destructive: search for the old/dropped name (finding it = stale reference)
    // For add/create: search for the new name (not finding it = missing update)
    const searchName = isDestructive
      ? (entity.oldName ?? entity.column ?? entity.table)
      : (entity.column ?? entity.table);

    const pattern = new RegExp(`\\b${escapeRe(searchName)}\\b`);

    return {
      entity,
      typeLayer: searchLayer(roots.types, pattern, cwd),
      apiLayer: searchLayer(roots.api, pattern, cwd),
      uiLayer: searchLayer(roots.ui, pattern, cwd),
    };
  });
}
