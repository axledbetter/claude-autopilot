import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectStack } from '../src/core/detect/stack.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stack-')); }

describe('detectStack', () => {
  test('detects Go with Gin', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'go.mod'), 'module example\n\nrequire github.com/gin-gonic/gin v1.9.0\n');
    assert.equal(detectStack(d), 'Go + Gin');
  });

  test('detects plain Go', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'go.mod'), 'module example\ngo 1.21\n');
    assert.equal(detectStack(d), 'Go');
  });

  test('detects Rails', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem 'pg'\n");
    const result = detectStack(d);
    assert.ok(result?.includes('Ruby on Rails'), `expected Rails, got: ${result}`);
    assert.ok(result?.includes('PostgreSQL'), `expected PostgreSQL, got: ${result}`);
  });

  test('detects FastAPI', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'requirements.txt'), 'fastapi==0.110.0\npydantic==2.0\n');
    const result = detectStack(d);
    assert.ok(result?.includes('FastAPI'), `expected FastAPI, got: ${result}`);
    assert.ok(result?.includes('Pydantic'), `expected Pydantic, got: ${result}`);
  });

  test('detects Next.js + Supabase + TypeScript', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      dependencies: { next: '^15.0.0', '@supabase/supabase-js': '^2.0.0', tailwindcss: '^3.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    fs.writeFileSync(path.join(d, 'tsconfig.json'), '{}');
    const result = detectStack(d);
    assert.ok(result?.includes('Next.js'), `expected Next.js, got: ${result}`);
    assert.ok(result?.includes('Supabase'), `expected Supabase, got: ${result}`);
    assert.ok(result?.includes('TypeScript'), `expected TypeScript, got: ${result}`);
    assert.ok(result?.includes('Tailwind'), `expected Tailwind, got: ${result}`);
  });

  test('detects Next.js with tRPC', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', '@trpc/server': '^10.0.0' },
    }));
    const result = detectStack(d);
    assert.ok(result?.includes('Next.js'), `expected Next.js, got: ${result}`);
    assert.ok(result?.includes('tRPC'), `expected tRPC, got: ${result}`);
  });

  test('detects Express + Prisma', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.18.0', '@prisma/client': '^5.0.0' },
    }));
    const result = detectStack(d);
    assert.ok(result?.includes('Express'), `expected Express, got: ${result}`);
    assert.ok(result?.includes('Prisma'), `expected Prisma, got: ${result}`);
  });

  test('returns null for empty directory', () => {
    const d = tmp();
    assert.equal(detectStack(d), null);
  });

  test('detects Rust + Axum', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'Cargo.toml'),
      '[package]\nname = "api"\n\n[dependencies]\naxum = "0.7"\ntokio = "1"\nserde = "1"\n');
    const result = detectStack(d);
    assert.ok(result?.includes('Rust'), `expected Rust, got: ${result}`);
    assert.ok(result?.includes('Axum'), `expected Axum, got: ${result}`);
    assert.ok(result?.includes('Tokio'), `expected Tokio, got: ${result}`);
  });
});
