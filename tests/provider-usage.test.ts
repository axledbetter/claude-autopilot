import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectProviderUsage, dominantProvider } from '../src/core/detect/provider-usage.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-prov-'));
}

describe('detectProviderUsage', () => {
  test('counts anthropic pattern in a ts file', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'client.ts'), 'const key = process.env.ANTHROPIC_API_KEY;');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.anthropic, 1);
    assert.equal(counts.openai, 0);
    assert.equal(counts.gemini, 0);
    assert.equal(counts.groq, 0);
  });

  test('counts openai pattern', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'llm.ts'), 'process.env.OPENAI_API_KEY');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.openai, 1);
    assert.equal(counts.anthropic, 0);
  });

  test('counts gemini pattern', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'ai.ts'), 'import "@google/generative-ai";');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.gemini, 1);
  });

  test('counts groq pattern', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'ai.ts'), 'baseURL: "https://api.groq.com/openai/v1"');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.groq, 1);
  });

  test('caps at 1 per file even with multiple matches', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'),
      'ANTHROPIC_API_KEY\nANTHROPIC_API_KEY\nANTHROPIC_API_KEY');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.anthropic, 1);
  });

  test('accumulates across multiple files', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'ANTHROPIC_API_KEY');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'ANTHROPIC_API_KEY');
    fs.writeFileSync(path.join(dir, 'c.ts'), 'OPENAI_API_KEY');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.anthropic, 2);
    assert.equal(counts.openai, 1);
  });

  test('skips node_modules', () => {
    const dir = makeTmpDir();
    const nm = path.join(dir, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'index.ts'), 'ANTHROPIC_API_KEY');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.anthropic, 0);
  });

  test('skips non-source files (.json, .md)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'set ANTHROPIC_API_KEY in your env');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"key":"ANTHROPIC_API_KEY"}');
    const counts = detectProviderUsage(dir);
    assert.equal(counts.anthropic, 0);
  });

  test('returns zeros for empty directory', () => {
    const dir = makeTmpDir();
    const counts = detectProviderUsage(dir);
    assert.deepEqual(counts, { anthropic: 0, gemini: 0, openai: 0, groq: 0 });
  });
});

describe('dominantProvider', () => {
  test('returns provider with highest count', () => {
    assert.equal(dominantProvider({ anthropic: 5, gemini: 2, openai: 3, groq: 0 }), 'anthropic');
  });

  test('returns null when all zero', () => {
    assert.equal(dominantProvider({ anthropic: 0, gemini: 0, openai: 0, groq: 0 }), null);
  });

  test('returns first max when tied', () => {
    const result = dominantProvider({ anthropic: 3, gemini: 3, openai: 1, groq: 0 });
    assert.ok(result === 'anthropic' || result === 'gemini');
  });
});
