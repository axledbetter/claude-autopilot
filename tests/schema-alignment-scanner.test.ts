import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scanner-'));
  fs.mkdirSync(path.join(dir, 'types'));
  fs.mkdirSync(path.join(dir, 'app', 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app', 'components'), { recursive: true });
  return dir;
}

describe('scanLayers', () => {
  it('finds evidence in type layer when column name present', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { status: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected type layer evidence');
    assert.ok(results[0]!.typeLayer!.file.includes('user.ts'));
    fs.rmSync(dir, { recursive: true });
  });

  it('returns null for missing layer', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    // types dir exists but no file references 'status'
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { id: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
    );
    assert.equal(results[0]!.typeLayer, null, 'expected null for missing type');
    fs.rmSync(dir, { recursive: true });
  });

  it('drop_column: finds evidence of OLD name as a gap', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { legacy_field: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'legacy_field', operation: 'drop_column' }],
      dir,
    );
    // For drop_column: finding OLD name in type layer = stale reference = evidence present
    assert.ok(results[0]!.typeLayer !== null, 'expected stale ref evidence for drop_column');
    fs.rmSync(dir, { recursive: true });
  });

  it('rename_column: searches for oldName', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.writeFileSync(path.join(dir, 'types', 'user.ts'), 'export interface User { old_name: string; }');

    const results = scanLayers(
      [{ table: 'users', column: 'new_name', operation: 'rename_column', oldName: 'old_name' }],
      dir,
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected stale old_name evidence');
    fs.rmSync(dir, { recursive: true });
  });

  it('UI layer excludes files under API/type roots (overlap prevention)', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    // Put the reference ONLY under app/api/ — UI search over app/ must NOT find it
    fs.writeFileSync(path.join(dir, 'app', 'api', 'handler.ts'), 'export const h = { status: "ok" };');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
    );
    assert.ok(results[0]!.apiLayer !== null, 'expected API evidence');
    assert.equal(results[0]!.uiLayer, null, 'UI layer should NOT pick up app/api/ file');
    fs.rmSync(dir, { recursive: true });
  });

  it('respects layerRoots config override', async () => {
    const { scanLayers } = await import('../src/core/schema-alignment/scanner.ts');
    const dir = makeTmpProject();
    fs.mkdirSync(path.join(dir, 'custom', 'types'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'custom', 'types', 'user.ts'), 'export type User = { status: string };');

    const results = scanLayers(
      [{ table: 'users', column: 'status', operation: 'add_column' }],
      dir,
      { layerRoots: { types: ['custom/types/'] } },
    );
    assert.ok(results[0]!.typeLayer !== null, 'expected evidence in custom type dir');
    fs.rmSync(dir, { recursive: true });
  });
});
