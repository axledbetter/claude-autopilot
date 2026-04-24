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
  const req = createRequire(import.meta.url);

  // Strategy 1: resolve the entrypoint directly. Works when the main package
  // declares `./bin/claude-autopilot.js` in its `exports` field. (As of v5.0.0-alpha.3+,
  // it does.) Skipped silently under older versions that lack the export.
  try {
    return req.resolve('@delegance/claude-autopilot/bin/claude-autopilot.js');
  } catch {
    /* fall through */
  }

  // Strategy 2: resolve the main package's package.json (always exposed by
  // node's resolver even when `exports` is restrictive) and derive the bin
  // path from it. Works under npm, pnpm, yarn classic hoisted, yarn PnP,
  // Deno's npm compat layer.
  try {
    const pkgJson = req.resolve('@delegance/claude-autopilot/package.json');
    const pkgDir = path.dirname(pkgJson);
    const candidate = path.join(pkgDir, 'bin', 'claude-autopilot.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }

  // Strategy 3: relative probe of sibling node_modules layouts (when the
  // tombstone is installed globally next to the real package without either
  // being resolvable via the module graph).
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
    path.resolve(__dirname, '..', '..', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
    path.resolve(__dirname, '..', '..', '..', '@delegance', 'claude-autopilot', 'bin', 'claude-autopilot.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Strategy 4: PATH lookup of the co-installed bin.
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
