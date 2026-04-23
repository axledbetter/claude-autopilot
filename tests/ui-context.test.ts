import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasFrontendFiles, loadDesignContext } from '../src/core/ui/design-context-loader.ts';

describe('hasFrontendFiles', () => {
  it('returns true for .tsx', () => assert.ok(hasFrontendFiles(['app/page.tsx'])));
  it('returns true for .mdx', () => assert.ok(hasFrontendFiles(['docs/guide.mdx'])));
  it('returns true for tailwind.config.ts', () => assert.ok(hasFrontendFiles(['tailwind.config.ts'])));
  it('returns true for tailwind.config.js', () => assert.ok(hasFrontendFiles(['tailwind.config.js'])));
  it('returns false for .ts only', () => assert.ok(!hasFrontendFiles(['src/service.ts'])));
  it('returns false for empty list', () => assert.ok(!hasFrontendFiles([])));
});

describe('loadDesignContext', () => {
  it('returns null when lib is undefined', () => {
    assert.equal(loadDesignContext(undefined, process.cwd()), null);
  });

  it('loads string form (guide-only) with delimiters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    const guidePath = path.join(dir, 'guide.md');
    fs.writeFileSync(guidePath, '# Button\nUse <Button variant="primary"> for CTAs.');
    const result = loadDesignContext(guidePath, dir);
    assert.ok(result?.includes('BEGIN_DESIGN_CONTEXT'));
    assert.ok(result?.includes('Usage Guide'));
    assert.ok(result?.includes('Button'));
    fs.rmSync(dir, { recursive: true });
  });

  it('loads tokens + guide with combined output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ 'color-primary': '#0070f3', 'z-index': 10 }));
    fs.writeFileSync(path.join(dir, 'guide.md'), '# Usage');
    const result = loadDesignContext({ tokens: path.join(dir, 'tokens.json'), guide: path.join(dir, 'guide.md') }, dir);
    assert.ok(result?.includes('### Tokens'));
    assert.ok(result?.includes('color-primary: #0070f3'));
    assert.ok(result?.includes('### Usage Guide'));
    fs.rmSync(dir, { recursive: true });
  });

  it('tokens: nested objects get [object] placeholder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ alpha: 'red', beta: { nested: true } }));
    const result = loadDesignContext({ tokens: path.join(dir, 'tokens.json') }, dir);
    assert.ok(result?.includes('alpha: red'));
    assert.ok(result?.includes('beta: [object]'));
    fs.rmSync(dir, { recursive: true });
  });

  it('tokens: keys sorted alphabetically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ z: 'z', a: 'a', m: 'm' }));
    const result = loadDesignContext({ tokens: path.join(dir, 'tokens.json') }, dir);
    const idxA = result!.indexOf('a: a');
    const idxM = result!.indexOf('m: m');
    const idxZ = result!.indexOf('z: z');
    assert.ok(idxA < idxM && idxM < idxZ);
    fs.rmSync(dir, { recursive: true });
  });

  it('invalid JSON returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(path.join(dir, 'tokens.json'), '{ not json }');
    assert.equal(loadDesignContext({ tokens: path.join(dir, 'tokens.json') }, dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it('missing file returns null', () => {
    assert.equal(loadDesignContext({ guide: '/nonexistent/guide.md' }, process.cwd()), null);
  });

  it('path outside workspace returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    const escape = path.join(dir, '..', 'escape.md');
    assert.equal(loadDesignContext(escape, dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it('guide truncated at 2000 chars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(path.join(dir, 'guide.md'), 'x'.repeat(3000));
    const result = loadDesignContext(path.join(dir, 'guide.md'), dir);
    assert.ok(result?.includes('[...truncated]'));
    fs.rmSync(dir, { recursive: true });
  });
});
