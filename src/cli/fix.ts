import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { Finding } from '../core/findings/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

const CONTEXT_LINES = 20;

// LLM error / refusal phrases that indicate a bad output
const REFUSAL_PHRASES = [
  'i cannot', "i can't", 'i am unable', 'as an ai', 'as a language model',
  'i apologize', 'i\'m sorry', 'cannot safely', 'would require', 'error:',
];

export interface FixCommandOptions {
  cwd?: string;
  configPath?: string;
  severity?: 'critical' | 'warning' | 'all';
  dryRun?: boolean;
  yes?: boolean;  // skip per-fix confirmation prompts
}

interface FixResult {
  file: string;
  line: number;
  findingMessage: string;
  status: 'fixed' | 'skipped' | 'rejected' | 'failed';
  reason?: string;
}

function unifiedDiff(original: string[], replacement: string[], filePath: string, startLine: number): string {
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath} (proposed fix)`, `@@ -${startLine},${original.length} +${startLine},${replacement.length} @@`];
  for (const l of original) lines.push(fmt('red', `- ${l}`));
  for (const l of replacement) lines.push(fmt('green', `+ ${l}`));
  return lines.join('\n');
}

function validateReplacement(original: string[], replacement: string[], finding: Finding): string | null {
  if (replacement.length === 0) return 'LLM returned empty output';

  // Reject obvious LLM refusals
  const joined = replacement.join(' ').toLowerCase();
  for (const phrase of REFUSAL_PHRASES) {
    if (joined.includes(phrase)) return `LLM refused: "${replacement[0]?.slice(0, 60)}"`;
  }

  // Reject if line count ballooned more than 3x (likely hallucination)
  if (replacement.length > original.length * 3 + 10) {
    return `Suspicious: replacement is ${replacement.length} lines vs original ${original.length}`;
  }

  // Reject if the replacement is identical (LLM made no change)
  if (replacement.join('\n') === original.join('\n')) {
    return 'LLM returned identical code — no change made';
  }

  return null;
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

  const fixable = findings.filter(f => {
    if (!f.line || !f.file || f.file === '<unspecified>' || f.file === '<pipeline>') return false;
    if (severityFilter === 'all') return true;
    if (severityFilter === 'critical') return f.severity === 'critical';
    return f.severity === 'critical' || f.severity === 'warning';
  });

  if (fixable.length === 0) {
    console.log(fmt('yellow', `[fix] No fixable findings (severity=${severityFilter}, need file+line).`));
    return 0;
  }

  const modeNote = options.dryRun ? ' (dry run)' : options.yes ? '' : ' (interactive — use --yes to skip prompts)';
  console.log(`\n${fmt('bold', '[guardrail fix]')} ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} to attempt${modeNote}\n`);

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

  // Load review engine (config optional — defaults to auto adapter)
  let engine: ReviewEngine;
  try {
    const config = fs.existsSync(configPath) ? await loadConfig(configPath) : null;
    const ref = config
      ? (typeof config.reviewEngine === 'string' ? config.reviewEngine : (config.reviewEngine?.adapter ?? 'auto'))
      : 'auto';
    engine = await loadAdapter<ReviewEngine>({
      point: 'review-engine',
      ref,
      options: config && typeof config.reviewEngine === 'object' ? config.reviewEngine.options : undefined,
    });
  } catch (err) {
    console.error(fmt('red', `[fix] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
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
    const diff = unifiedDiff(result.originalLines!, result.replacementLines!, finding.file, result.startLine!);

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
      const allLines = fs.readFileSync(absPath, 'utf8').split('\n');
      const newLines = [
        ...allLines.slice(0, result.startLine! - 1),
        ...result.replacementLines!,
        ...allLines.slice(result.endLine!),
      ];
      const tmp = absPath + '.guardrail.tmp';
      fs.writeFileSync(tmp, newLines.join('\n'), 'utf8');
      fs.renameSync(tmp, absPath);
      console.log(fmt('green', `    ✓ applied`));
      results.push({ file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'fixed' });
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

interface GenerateResult {
  status: 'ok' | 'cannot_fix' | 'rejected' | 'error';
  reason?: string;
  originalLines?: string[];
  replacementLines?: string[];
  startLine?: number;
  endLine?: number;
}

async function generateFix(finding: Finding, engine: ReviewEngine, cwd: string): Promise<GenerateResult> {
  const absPath = path.resolve(cwd, finding.file);
  let fileLines: string[];
  try {
    fileLines = fs.readFileSync(absPath, 'utf8').split('\n');
  } catch {
    return { status: 'cannot_fix', reason: 'file not readable' };
  }

  const lineIdx = finding.line! - 1;
  if (lineIdx < 0 || lineIdx >= fileLines.length) {
    return { status: 'cannot_fix', reason: 'line out of range' };
  }

  const startIdx = Math.max(0, lineIdx - CONTEXT_LINES);
  const endIdx   = Math.min(fileLines.length - 1, lineIdx + CONTEXT_LINES);
  const contextLines = fileLines.slice(startIdx, endIdx + 1);
  const startLine = startIdx + 1;

  const numbered = contextLines.map((l, i) => {
    const n = startLine + i;
    return `${n === finding.line ? '>>>' : '   '} ${String(n).padStart(4)}: ${l}`;
  }).join('\n');

  const prompt = [
    `File: ${finding.file}`,
    `Finding (line ${finding.line}): [${finding.severity.toUpperCase()}] ${finding.message}`,
    finding.suggestion ? `Suggestion: ${finding.suggestion}` : '',
    '',
    'Relevant lines (>>> marks the finding):',
    '```',
    numbered,
    '```',
    '',
    `Rewrite ONLY lines ${startLine}–${endIdx + 1} to fix this finding.`,
    'Rules:',
    '- Output ONLY the replacement lines with no explanation, no markdown fences, no line numbers',
    '- Preserve indentation exactly',
    '- Make the minimal change needed — do not refactor unrelated code',
    '- If the fix cannot be done safely in this context, output exactly: CANNOT_FIX',
  ].filter(Boolean).join('\n');

  let rawOutput: string;
  try {
    const output = await engine.review({ content: prompt, kind: 'file-batch' });
    rawOutput = output.rawOutput.trim();
  } catch (err) {
    return { status: 'error', reason: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (rawOutput === 'CANNOT_FIX' || rawOutput.startsWith('CANNOT_FIX')) {
    return { status: 'cannot_fix', reason: 'LLM: cannot fix safely in this context' };
  }

  // Strip markdown fences if the model added them despite instructions
  const cleaned = rawOutput
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trimEnd();

  const replacementLines = cleaned.split('\n');
  const originalLines = contextLines;

  const validationError = validateReplacement(originalLines, replacementLines, finding);
  if (validationError) {
    return { status: 'rejected', reason: validationError };
  }

  return {
    status: 'ok',
    originalLines,
    replacementLines,
    startLine,
    endLine: endIdx + 1,
  };
}
