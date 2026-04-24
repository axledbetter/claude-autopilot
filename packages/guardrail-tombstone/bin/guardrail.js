#!/usr/bin/env node
/**
 * Tombstone bin for @delegance/guardrail@5.0.0+.
 *
 * @delegance/guardrail was renamed to @delegance/claude-autopilot in v5. Users
 * still pinned to @delegance/guardrail install this thin wrapper, which forwards
 * argv to the new package with strict stdio + exit-code + signal passthrough.
 *
 * Resolution strategy (per Codex review of alpha.3 spec):
 *   1. node module resolution via createRequire — works across npm/pnpm/yarn/PnP
 *   2. relative probe of sibling node_modules — fallback when require fails
 *   3. PATH lookup of `claude-autopilot` — last-resort safety net
 *
 * No behavioral interpretation — every byte the child writes is forwarded.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPRECATION_NOTICE =
  '\x1b[33m[deprecated]\x1b[0m @delegance/guardrail renamed to @delegance/claude-autopilot. ' +
  'This package is a thin forwarding wrapper — identical behavior. ' +
  'Migrate: npm install @delegance/claude-autopilot@alpha && npx @delegance/claude-autopilot migrate-v4 --write\n' +
  'Silence: set CLAUDE_AUTOPILOT_DEPRECATION=never\n';

function resolveClaudeAutopilotBin() {
  // Strategy 1: node's module resolver via createRequire. Works under npm, pnpm,
  // yarn Plug-n-Play, yarn classic hoisted, Deno's npm compat, etc.
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('@delegance/claude-autopilot/bin/claude-autopilot.js');
  } catch {
    /* fall through */
  }

  // Strategy 2: relative probe of sibling node_modules layouts (npm v3+ flat tree,
  // or when the tombstone is installed globally next to the real package).
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
    path.resolve(__dirname, '..', '..', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
    path.resolve(__dirname, '..', '..', '..', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Strategy 3: PATH lookup of the co-installed bin. This works when user did
  // `npm install -g @delegance/guardrail` AND has @delegance/claude-autopilot
  // installed globally alongside (or on $PATH via nvm/fnm managed shims).
  return null;
}

if (process.env.CLAUDE_AUTOPILOT_DEPRECATION !== 'never') {
  process.stderr.write(DEPRECATION_NOTICE);
}

const resolved = resolveClaudeAutopilotBin();
let result;
if (resolved) {
  // Spawn node directly on the resolved entrypoint — avoids bin-shim quirks on
  // Windows and under npm/yarn wrappers. process.execPath is the current node.
  result = spawnSync(process.execPath, [resolved, ...process.argv.slice(2)], { stdio: 'inherit' });
} else {
  // Last resort: shell out to `claude-autopilot` on PATH.
  result = spawnSync('claude-autopilot', process.argv.slice(2), { stdio: 'inherit' });
}

if (result.error) {
  if (result.error.code === 'ENOENT') {
    process.stderr.write(
      '[guardrail] @delegance/claude-autopilot not found. Install it:\n' +
      '  npm install -g @delegance/claude-autopilot@alpha\n' +
      'Or add it as a sibling dep of @delegance/guardrail in your project.\n',
    );
    process.exit(127);
  }
  process.stderr.write(`[guardrail] Launch failed: ${result.error.message}\n`);
  process.exit(127);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
