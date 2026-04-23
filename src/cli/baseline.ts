import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  loadBaseline, saveBaseline, clearBaseline, diffAgainstBaseline,
  baselineFilePath,
} from '../core/persist/baseline.ts';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface BaselineCommandOptions {
  cwd?: string;
  note?: string;
  baselinePath?: string;
}

export async function runBaseline(sub: string, options: BaselineCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const bPath = baselineFilePath(cwd, options.baselinePath);
  const relPath = path.relative(cwd, bPath);

  switch (sub) {
    case 'create': {
      if (fs.existsSync(bPath)) {
        console.log(fmt('yellow', `[baseline] ${relPath} already exists — use \`guardrail baseline update\` to refresh, or \`guardrail baseline clear\` to reset`));
        return 1;
      }
      return createOrUpdate(cwd, bPath, relPath, options.note, 'Created');
    }

    case 'update': {
      return createOrUpdate(cwd, bPath, relPath, options.note, 'Updated');
    }

    case 'show': {
      const baseline = loadBaseline(cwd, options.baselinePath);
      if (!baseline) {
        console.log(fmt('yellow', `[baseline] No baseline found at ${relPath}`));
        console.log(fmt('dim', '  Run: guardrail baseline create'));
        return 0;
      }
      console.log(`\n${fmt('bold', '[guardrail baseline]')} ${fmt('dim', relPath)}`);
      console.log(fmt('dim', `  Created: ${baseline.createdAt}  Updated: ${baseline.updatedAt}`));
      if (baseline.note) console.log(fmt('dim', `  Note: ${baseline.note}`));
      console.log(`  ${baseline.entries.length} pinned finding${baseline.entries.length !== 1 ? 's' : ''}\n`);
      for (const e of baseline.entries) {
        const sev = e.severity === 'critical' ? fmt('red', 'CRIT') : e.severity === 'warning' ? fmt('yellow', 'WARN') : fmt('dim', 'NOTE');
        console.log(`  [${sev}] ${fmt('dim', `${e.file}${e.line ? `:${e.line}` : ''}`)} ${e.message.slice(0, 70)}`);
      }
      console.log('');
      return 0;
    }

    case 'diff': {
      const baseline = loadBaseline(cwd, options.baselinePath);
      if (!baseline) {
        console.log(fmt('yellow', `[baseline] No baseline found — run: guardrail baseline create`));
        return 1;
      }
      const current = loadCachedFindings(cwd);
      if (current.length === 0) {
        console.log(fmt('yellow', '[baseline] No cached findings — run `guardrail run` or `guardrail scan` first'));
        return 1;
      }
      const diff = diffAgainstBaseline(current, baseline);
      console.log(`\n${fmt('bold', '[guardrail baseline diff]')} vs ${fmt('dim', relPath)}\n`);

      if (diff.added.length > 0) {
        console.log(fmt('red', `  ${diff.added.length} new finding${diff.added.length !== 1 ? 's' : ''} (not in baseline):`));
        for (const f of diff.added) {
          const sev = f.severity === 'critical' ? fmt('red', 'CRIT') : f.severity === 'warning' ? fmt('yellow', 'WARN') : fmt('dim', 'NOTE');
          console.log(`    [${sev}] ${fmt('dim', `${f.file}${f.line ? `:${f.line}` : ''}`)} ${f.message.slice(0, 70)}`);
        }
        console.log('');
      }
      if (diff.resolved.length > 0) {
        console.log(fmt('green', `  ${diff.resolved.length} resolved (in baseline but not in current):`));
        for (const e of diff.resolved) {
          console.log(`    ${fmt('dim', `${e.file}${e.line ? `:${e.line}` : ''}`)} ${e.message.slice(0, 70)}`);
        }
        console.log('');
      }
      if (diff.added.length === 0 && diff.resolved.length === 0) {
        console.log(fmt('green', `  ✓ No changes vs baseline (${diff.unchanged.length} pinned findings unchanged)\n`));
      } else {
        console.log(fmt('dim', `  ${diff.unchanged.length} unchanged · run \`guardrail baseline update\` to pin new state\n`));
      }
      return diff.added.some(f => f.severity === 'critical') ? 1 : 0;
    }

    case 'clear': {
      if (!fs.existsSync(bPath)) {
        console.log(fmt('dim', `[baseline] No baseline at ${relPath} — nothing to clear`));
        return 0;
      }
      clearBaseline(cwd, options.baselinePath);
      console.log(fmt('green', `[baseline] Cleared ${relPath}`));
      return 0;
    }

    default:
      console.error(fmt('red', `[baseline] Unknown subcommand: "${sub}"`));
      console.error(fmt('dim', '  Usage: guardrail baseline <create|update|show|diff|clear> [--note "..."]'));
      return 1;
  }
}

function createOrUpdate(cwd: string, bPath: string, relPath: string, note: string | undefined, verb: string): number {
  const findings = loadCachedFindings(cwd);
  if (findings.length === 0) {
    console.log(fmt('yellow', '[baseline] No cached findings to snapshot — run `guardrail run` or `guardrail scan` first'));
    return 1;
  }
  const baseline = saveBaseline(cwd, findings, { note, overridePath: bPath === path.join(cwd, '.guardrail-baseline.json') ? undefined : bPath });
  console.log(`\n${fmt('green', `[baseline] ${verb}`)} ${fmt('dim', relPath)}`);
  console.log(`  ${baseline.entries.length} finding${baseline.entries.length !== 1 ? 's' : ''} pinned as accepted baseline`);
  if (note) console.log(`  Note: ${note}`);
  console.log(fmt('dim', `\n  Commit this file to share the baseline with your team:`));
  console.log(fmt('cyan', `    git add ${relPath} && git commit -m "chore: update guardrail baseline"\n`));
  return 0;
}
