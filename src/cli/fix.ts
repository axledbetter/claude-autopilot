import * as fs from 'node:fs';
import * as path from 'node:path';
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

const CONTEXT_LINES = 20; // lines of file context to send on each side of the finding

export interface FixCommandOptions {
  cwd?: string;
  configPath?: string;
  severity?: 'critical' | 'warning' | 'all'; // which findings to fix (default: critical)
  dryRun?: boolean;
}

interface FixResult {
  file: string;
  line: number;
  findingMessage: string;
  status: 'fixed' | 'skipped' | 'failed';
  reason?: string;
}

export async function runFix(options: FixCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'autopilot.config.yaml');
  const severityFilter = options.severity ?? 'critical';

  if (!fs.existsSync(configPath)) {
    console.error(fmt('red', `[fix] autopilot.config.yaml not found at ${configPath}`));
    return 1;
  }

  const findings = loadCachedFindings(cwd);
  if (findings.length === 0) {
    console.log(fmt('yellow', '[fix] No cached findings — run `autopilot run` first.'));
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

  console.log(`\n${fmt('bold', '[autopilot fix]')} ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} to attempt\n`);

  // Load review engine
  let engine: ReviewEngine;
  try {
    const config = await loadConfig(configPath);
    const ref = typeof config.reviewEngine === 'string' ? config.reviewEngine
      : (config.reviewEngine?.adapter ?? 'auto');
    engine = await loadAdapter<ReviewEngine>({
      point: 'review-engine',
      ref,
      options: typeof config.reviewEngine === 'object' ? config.reviewEngine.options : undefined,
    });
  } catch (err) {
    console.error(fmt('red', `[fix] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  const results: FixResult[] = [];

  for (const finding of fixable) {
    const result = await attemptFix(finding, engine, cwd, options.dryRun ?? false);
    results.push(result);
    const icon = result.status === 'fixed' ? fmt('green', '✓')
               : result.status === 'skipped' ? fmt('dim', '–')
               : fmt('red', '✗');
    const loc = `${result.file}:${result.line}`;
    console.log(`  ${icon}  ${loc.padEnd(40)} ${result.findingMessage.slice(0, 60)}`);
    if (result.reason) console.log(fmt('dim', `       ${result.reason}`));
  }

  const fixed = results.filter(r => r.status === 'fixed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  console.log('');
  if (options.dryRun) {
    console.log(fmt('yellow', `[fix] Dry run — no files modified. ${fixable.length} finding${fixable.length !== 1 ? 's' : ''} would be attempted.\n`));
  } else {
    console.log(fmt('green', `[fix] ${fixed} fixed`) + fmt('dim', `, ${failed} failed, ${results.length - fixed - failed} skipped\n`));
  }
  return failed > 0 ? 1 : 0;
}

async function attemptFix(
  finding: Finding,
  engine: ReviewEngine,
  cwd: string,
  dryRun: boolean,
): Promise<FixResult> {
  const base: FixResult = { file: finding.file, line: finding.line!, findingMessage: finding.message, status: 'skipped' };

  const absPath = path.resolve(cwd, finding.file);
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(absPath, 'utf8');
  } catch {
    return { ...base, status: 'skipped', reason: 'file not readable' };
  }

  const lines = fileContent.split('\n');
  const lineIdx = finding.line! - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return { ...base, status: 'skipped', reason: 'line out of range' };
  }

  const startIdx = Math.max(0, lineIdx - CONTEXT_LINES);
  const endIdx = Math.min(lines.length - 1, lineIdx + CONTEXT_LINES);
  const contextLines = lines.slice(startIdx, endIdx + 1);
  const startLine = startIdx + 1;

  const numbered = contextLines.map((l, i) => {
    const n = startLine + i;
    const marker = n === finding.line ? '>>>' : '   ';
    return `${marker} ${String(n).padStart(4)}: ${l}`;
  }).join('\n');

  const prompt = [
    `File: ${finding.file}`,
    `Finding (line ${finding.line}): [${finding.severity.toUpperCase()}] ${finding.message}`,
    finding.suggestion ? `Suggestion: ${finding.suggestion}` : '',
    '',
    'Here are the relevant lines (>>> marks the finding):',
    '```',
    numbered,
    '```',
    '',
    `Rewrite ONLY lines ${startLine}–${endIdx + 1} to fix this finding.`,
    'Rules:',
    '- Output ONLY the replacement lines, no explanation, no markdown fences',
    '- Preserve indentation and line count as much as possible',
    '- Make the minimal change needed to fix the finding',
    '- If the fix cannot be done safely in this context, output exactly: CANNOT_FIX',
  ].filter(Boolean).join('\n');

  let rawOutput: string;
  try {
    const output = await engine.review({ content: prompt, kind: 'file-batch' });
    rawOutput = output.rawOutput.trim();
  } catch (err) {
    return { ...base, status: 'failed', reason: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (rawOutput === 'CANNOT_FIX' || rawOutput.includes('CANNOT_FIX')) {
    return { ...base, status: 'skipped', reason: 'LLM: cannot fix safely' };
  }

  // Strip markdown fences if the model added them despite instructions
  const cleaned = rawOutput.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trimEnd();
  const replacementLines = cleaned.split('\n');

  if (dryRun) {
    return { ...base, status: 'fixed', reason: `(dry run) would replace lines ${startLine}–${endIdx + 1}` };
  }

  // Splice replacement into file
  const newLines = [
    ...lines.slice(0, startIdx),
    ...replacementLines,
    ...lines.slice(endIdx + 1),
  ];

  try {
    fs.writeFileSync(absPath, newLines.join('\n'), 'utf8');
  } catch (err) {
    return { ...base, status: 'failed', reason: `write error: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ...base, status: 'fixed' };
}
