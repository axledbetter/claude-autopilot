#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(__dirname, '..', 'src', 'cli', 'index.ts');

// Locate tsx: own node_modules (dev) → consumer's node_modules/.bin → PATH
function findTsx() {
  const own = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(own)) return own;
  const consumer = path.resolve(__dirname, '..', '..', '..', '.bin', 'tsx');
  if (fs.existsSync(consumer)) return consumer;
  return 'tsx';
}

const result = spawnSync(findTsx(), [entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
