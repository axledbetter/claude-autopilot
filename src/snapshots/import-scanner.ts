import * as fs from 'node:fs';
import * as path from 'node:path';

const IMPORT_RE = /^(?:import|export)\s+(?:.*?from\s+)?['"]([^'"]+)['"]/gm;

function allTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...allTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) results.push(full);
  }
  return results;
}

function resolveImport(importer: string, specifier: string, srcDir: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(importer), specifier);
  const withExt = abs.endsWith('.ts') ? abs : abs + '.ts';
  const rel = path.relative(srcDir, withExt).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel;
}

export function buildImportMap(srcDir: string): Record<string, string[]> {
  const absDir = path.resolve(srcDir);
  const files = allTsFiles(absDir);
  const map: Record<string, string[]> = {};

  for (const file of files) {
    const relImporter = path.relative(absDir, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const resolved = resolveImport(file, m[1]!, absDir);
      if (!resolved) continue;
      if (!map[resolved]) map[resolved] = [];
      if (!map[resolved]!.includes(relImporter)) map[resolved]!.push(relImporter);
    }
  }

  return map;
}
