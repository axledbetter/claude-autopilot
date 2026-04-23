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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

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
