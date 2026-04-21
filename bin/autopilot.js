#!/usr/bin/env node
// Thin launcher that uses tsx to run the TypeScript CLI entry point.
// This is what `npx autopilot` resolves to — it hands off to tsx so TypeScript
// source can execute without a separate build step during alpha.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
const entrypoint = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

const result = spawnSync(tsxBin, [entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
