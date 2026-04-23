import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildImportMap } from '../../scripts/snapshots/import-scanner.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impscan-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildImportMap', () => {
  it('AR5: finds direct importer relationships', () => {
    fs.mkdirSync(path.join(tmpDir, 'formatters'));
    fs.mkdirSync(path.join(tmpDir, 'cli'));
    fs.writeFileSync(path.join(tmpDir, 'formatters', 'sarif.ts'), 'export function toSarif() {}');
    fs.writeFileSync(
      path.join(tmpDir, 'formatters', 'index.ts'),
      "import { toSarif } from './sarif.ts';\nexport { toSarif };",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'cli', 'run.ts'),
      "import { toSarif } from '../formatters/sarif.ts';\n",
    );

    const map = buildImportMap(tmpDir);
    const key = 'formatters/sarif.ts';
    assert.ok(key in map, `Expected key "${key}" in map`);
    const importers = map[key]!.sort();
    assert.ok(importers.includes('cli/run.ts'));
    assert.ok(importers.includes('formatters/index.ts'));
  });

  it('AR6: handles re-export barrel files', () => {
    fs.mkdirSync(path.join(tmpDir, 'core'));
    fs.writeFileSync(path.join(tmpDir, 'core', 'pipeline.ts'), 'export function run() {}');
    fs.writeFileSync(
      path.join(tmpDir, 'core', 'index.ts'),
      "export { run } from './pipeline.ts';",
    );

    const map = buildImportMap(tmpDir);
    const key = 'core/pipeline.ts';
    assert.ok(key in map, `Expected key "${key}" in map`);
    assert.ok(map[key]!.includes('core/index.ts'));
  });
});
