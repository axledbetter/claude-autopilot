// @snapshot-for: src/snapshots/import-scanner.ts
// @generated-at: 2026-04-21T17:42:06.431Z
// @source-commit: d207869
// @generator-version: 1.0.0-alpha.6

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { buildImportMap } from '../../src/snapshots/import-scanner.ts';
import { normalizeSnapshot } from '../../src/snapshots/serializer.ts';

const SLUG = 'src-snapshots-import-scanner';
void SLUG;
const baselineRaw =
  process.env.CAPTURE_BASELINE === '1'
    ? '{}'
    : fs.readFileSync(
        fileURLToPath(new URL('./baselines/src-snapshots-import-scanner.json', import.meta.url)),
        'utf8',
      );
const baseline = JSON.parse(baselineRaw);
const captured: Record<string, unknown> = {};
process.on('exit', () => {
  if (process.env.CAPTURE_BASELINE === '1') {
    const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
      ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, 'src-snapshots-import-scanner.json')
      : fileURLToPath(new URL('./baselines/src-snapshots-import-scanner.json', import.meta.url));
    fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
  }
});

function mkTempDir(name: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), `.tmp-${name}-`));
}

describe('buildImportMap snapshots', () => {
  it('captures relative import and export-from edges', () => {
    const dir = mkTempDir('import-scanner-basic');
    fs.mkdirSync(path.join(dir, 'feature'), { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'feature', 'util.ts'),
      `export const util = 1;\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'feature', 'index.ts'),
      `import { util } from './util';
export { util as u } from './util';
`,
      'utf8',
    );

    const result = buildImportMap(dir);

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['captures relative import and export-from edges'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['captures relative import and export-from edges']),
    );
  });

  it('ignores non-relative imports and deduplicates importers per target', () => {
    const dir = mkTempDir('import-scanner-dedupe');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'lib', 'shared.ts'), `export const x = 1;\n`, 'utf8');
    fs.writeFileSync(
      path.join(dir, 'a.ts'),
      `import { readFileSync } from 'node:fs';
import { x } from './lib/shared';
import { y } from "./lib/shared";
`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      `export { x } from './lib/shared';\n`,
      'utf8',
    );

    const result = buildImportMap(dir);

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['ignores non-relative imports and deduplicates importers per target'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['ignores non-relative imports and deduplicates importers per target']),
    );
  });

  it('excludes imports that resolve outside srcDir', () => {
    const root = mkTempDir('import-scanner-outside');
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'pkg'), { recursive: true });

    fs.writeFileSync(path.join(src, 'pkg', 'inside.ts'), `export const ok = true;\n`, 'utf8');
    fs.writeFileSync(
      path.join(src, 'pkg', 'consumer.ts'),
      `import { ok } from './inside';
import x from '../outside';
import y from '../../totally-out';
`,
      'utf8',
    );

    const result = buildImportMap(src);

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['excludes imports that resolve outside srcDir'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['excludes imports that resolve outside srcDir']),
    );
  });
});
