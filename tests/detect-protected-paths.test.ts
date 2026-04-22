import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProtectedPaths } from '../src/core/detect/protected-paths.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-prot-')); }

describe('detectProtectedPaths', () => {
  test('returns empty for bare directory', () => {
    const d = tmp();
    assert.deepEqual(detectProtectedPaths(d), []);
  });

  test('detects data/deltas', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'data', 'deltas'), { recursive: true });
    assert.ok(detectProtectedPaths(d).includes('data/deltas/**'));
  });

  test('detects prisma/migrations', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'prisma', 'migrations'), { recursive: true });
    const result = detectProtectedPaths(d);
    assert.ok(result.includes('prisma/migrations/**'), `got: ${result}`);
  });

  test('detects db/migrate (Rails)', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'db', 'migrate'), { recursive: true });
    assert.ok(detectProtectedPaths(d).includes('db/migrate/**'));
  });

  test('detects alembic/versions (Python)', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'alembic', 'versions'), { recursive: true });
    assert.ok(detectProtectedPaths(d).includes('alembic/versions/**'));
  });

  test('detects terraform directory', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'terraform'), { recursive: true });
    assert.ok(detectProtectedPaths(d).includes('terraform/**'));
  });

  test('detects root-level .sql files', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'seed.sql'), 'SELECT 1;');
    assert.ok(detectProtectedPaths(d).includes('*.sql'));
  });

  test('detects prisma schema file', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(d, 'prisma', 'schema.prisma'), 'datasource db {}');
    assert.ok(detectProtectedPaths(d).includes('prisma/**'));
  });

  test('detects multiple signals together', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(d, 'terraform'), { recursive: true });
    const result = detectProtectedPaths(d);
    assert.ok(result.includes('migrations/**'));
    assert.ok(result.includes('terraform/**'));
  });
});
