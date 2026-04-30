import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { Finding } from '../core/findings/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { generateFix, buildUnifiedDiff, type GenerateResult } from '../core/fix/generator.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface FixCommandOptions {
  cwd?: string;
  configPath?: string;
  severity?: 'critical' | 'warning' | 'all';
  dryRun?: boolean;
  yes?: boolean;      // skip per-fix confirmation prompts
  noVerify?: boolean; // skip test verification after applying fix
}

interface FixResult {
  file: string;
  line: number;
  findingMessage: string;
  status: 'fixed' | 'skipped' | 'rejected' | 'failed';
  reason?: string;
}

async function confirmFix(diff: string, finding: Finding): Promise<'yes' | 'no' | 'quit'> {
  console.log('');
  console.log(diff);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(fmt('bold', '  Apply this fix? [y]es / [n]o / [q]uit  '), answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'q') resolve('quit');
      else if (a === 'y' || a === '') resolve('yes');
      else resolve('no');
    });
  });
}

export async function runFix(options: FixCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');
  const severityFilter = options.severity ?? 'critical';

  const findings = loadCachedFindings(cwd);
  if (findings.length === 0) {
    console.log(fmt('yellow', '[fix] No cached findings — run `guardrail scan <path>` or `guardrail run` first.'));
    return 0;
  }

  // Two gates:
  //  - "actionable": has a real file path. Surfaced in dry-run so the user sees
  //    findings even when the LLM didn't pin a line number.
  //  - "fixable": also has a line. The LLM-fix loop needs both to extract a
  //    code snippet around the finding location.
  const actionable = findings.filter(f => {
    if (!f.file || f.file === '<unspecified>' || f.file === '<pipeline>') return false;
    if (severityFilter === 'all') return true;
    if (severityFilter === 'critical') return f.severity === 'critical';
    return f.severity === 'critical' || f.severity === 'warning';
  });
  const fixable = actionable.filter(f => f.line && f.line > 0);

  if (actionable.length === 0) {
    console.log(fmt('yellow', `[fix] No actionable findings (severity=${severityFilter}, need file path).`));
    return 0;
  }
  if (fixable.length === 0) {
    const verb = actionable.length === 1 ? 'has' : 'have';
    const noun = actionable.length === 1 ? 'finding' : 'findings';
    console.log(fmt('yellow', `[fix] ${actionable.length} ${noun} ${verb} file but no line — model output was line-less. Re-run scan with --ask "include line numbers" or run \`claude-autopilot run\` for richer extraction.`));
    for (const f of actionable) {
      const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL')
        : f.severity === 'warning' ? fmt('yellow', 'WARNING ')
        : fmt('dim', 'NOTE    ');
      console.log(`  [${sev}] ${fmt('dim', f.file)} ${f.message}`);
    }
    return 0;
  }

  const modeNote = options.dryRun ? ' (dry run)' : options.yes ? '' : ' (interactive — use --yes to skip prompts)';
  console.log(`\n${fmt('bold', '[fix]')} ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} to attempt${modeNote}\n`);

  // Print upfront summary of all fixable findings before prompting
  for (const f of fixable) {
    const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING ');
    const loc = fmt('dim', `${f.file}:${f.line}`);
    console.log(`  [${sev}] ${loc} ${f.message}`);
    if (f.suggestion) console.log(fmt('dim', `           → ${f.suggestion}`));
  }
  console.log('');

  // Dry-run: listing the findings is sufficient — no LLM needed
  if (options.dryRun) {
    console.log(fmt('yellow', `[fix] Dry run — ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} listed above, no files modified.\n`));
    return 0;
  }

  // Load config + review engine (config optional — defaults to auto adapter)
  let engine: ReviewEngine;
  let loadedConfig: GuardrailConfig | null = null;
  try {
    loadedConfig = fs.existsSync(configPath) ? await loadConfig(configPath) : null;
    const ref = loadedConfig
      ? (typeof loadedConfig.reviewEngine === 'string' ? loadedConfig.reviewEngine : (loadedConfig.reviewEngine?.adapter ?? 'auto'))
      : 'auto';
    engine = await loadAdapter<ReviewEngine>({
      point: 'review-engine',
      ref,
      options: loadedConfig && typeof loadedConfig.reviewEngine === 'object' ? loadedConfig.reviewEngine.options : undefined,
    });
  } catch (err) {
    console.error(fmt('red', `[fix] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  const testCommand = loadedConfig?.testCommand ?? null;
  const shouldVerify = !options.noVerify && !!testCommand;
  if (shouldVerify) {
    console.log(fmt('dim', `[fix] Verified mode — running "${testCommand}" after each fix\n`));
  }

  const results: FixResult[] = [];
  let quit = false;

  for (const finding of fixable) {
    if (quit) {
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user quit' });
      continue;
    }

    const sev = finding.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING');
    console.log(`\n  [${sev}] ${fmt('dim', `${finding.file}:${finding.line}`)} ${finding.message}`);

    const result = await generateFix(finding, engine, cwd);

    if (result.status === 'cannot_fix') {
      console.log(fmt('dim', `    → skipped: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: result.reason });
      continue;
    }

    if (result.status === 'rejected') {
      console.log(fmt('yellow', `    → rejected: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'rejected', reason: result.reason });
      continue;
    }

    if (result.status === 'error') {
      console.log(fmt('red', `    → error: ${result.reason}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'failed', reason: result.reason });
      continue;
    }

    // Show diff
    const diff = buildUnifiedDiff(result.originalLines!, result.replacementLines!, finding.file, result.startLine!);

    if (options.dryRun) {
      console.log('');
      console.log(diff);
      console.log(fmt('dim', '    (dry run — not applied)'));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'dry run' });
      continue;
    }

    // Interactive confirmation (unless --yes)
    if (!options.yes) {
      const answer = await confirmFix(diff, finding);
      if (answer === 'quit') {
        quit = true;
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user quit' });
        continue;
      }
      if (answer === 'no') {
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped', reason: 'user declined' });
        continue;
      }
    } else {
      // --yes mode: still print the diff so there's a record
      console.log('');
      console.log(diff);
    }

    // Apply fix atomically
    try {
      const absPath = path.resolve(cwd, finding.file);
      const originalContent = fs.readFileSync(absPath, 'utf8');
      const allLines = originalContent.split('\n');
      const newLines = [
        ...allLines.slice(0, result.startLine! - 1),
        ...result.replacementLines!,
        ...allLines.slice(result.endLine!),
      ];
      const tmp = absPath + '.guardrail.tmp';
      fs.writeFileSync(tmp, newLines.join('\n'), 'utf8');
      fs.renameSync(tmp, absPath);

      if (shouldVerify) {
        // Verified mode — same shell invocation pattern as phases/tests.ts
        console.log(fmt('dim', `    ↻ verifying…`));
        const passed = runTestCommand(testCommand!, cwd);
        if (passed) {
          console.log(fmt('green', `    ✓ applied + tests pass`));
          results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'fixed' });
        } else {
          fs.writeFileSync(absPath, originalContent, 'utf8');
          console.log(fmt('yellow', `    ⚠ reverted — tests failed after fix`));
          results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'rejected', reason: 'tests failed after fix — reverted' });
        }
      } else {
        console.log(fmt('green', `    ✓ applied`));
        results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'fixed' });
      }
    } catch (err) {
      console.log(fmt('red', `    ✗ write failed: ${err instanceof Error ? err.message : String(err)}`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'failed', reason: String(err) });
    }
  }

  const fixed    = results.filter(r => r.status === 'fixed').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  const failed   = results.filter(r => r.status === 'failed').length;
  const skipped  = results.filter(r => r.status === 'skipped').length;

  console.log('');
  if (options.dryRun) {
    console.log(fmt('yellow', `[fix] Dry run complete — ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} previewed, no files modified.\n`));
  } else {
    const parts = [
      fixed   > 0 ? fmt('green',  `${fixed} fixed`)    : null,
      rejected > 0 ? fmt('yellow', `${rejected} rejected`) : null,
      failed  > 0 ? fmt('red',    `${failed} failed`)   : null,
      skipped > 0 ? fmt('dim',    `${skipped} skipped`)  : null,
    ].filter(Boolean).join(fmt('dim', ' · '));
    console.log(`[fix] ${parts}\n`);
  }

  return failed > 0 ? 1 : 0;
}

function runTestCommand(cmd: string, cwd: string): boolean {
  try {
    execSync(cmd, {
      cwd,
      stdio: 'ignore',
      timeout: 120000,
      shell: process.env.SHELL ?? '/bin/sh',
    });
    return true;
  } catch {
    return false;
  }
}

