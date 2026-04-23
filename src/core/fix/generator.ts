import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '../findings/types.ts';
import type { ReviewEngine } from '../../adapters/review-engine/types.ts';

export const CONTEXT_LINES = 20;

// LLM error / refusal phrases that indicate a bad output
const REFUSAL_PHRASES = [
  'i cannot', "i can't", 'i am unable', 'as an ai', 'as a language model',
  'i apologize', "i'm sorry", 'cannot safely', 'would require', 'error:',
];

export interface GenerateResult {
  status: 'ok' | 'cannot_fix' | 'rejected' | 'error';
  reason?: string;
  originalLines?: string[];
  replacementLines?: string[];
  startLine?: number;
  endLine?: number;
}

export function validateReplacement(original: string[], replacement: string[], _finding: Finding): string | null {
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

export function buildUnifiedDiff(
  original: string[],
  replacement: string[],
  filePath: string,
  startLine: number,
  opts: { color?: boolean } = {},
): string {
  // Colors default on for CLI ergonomics; MCP callers pass color:false so ANSI
  // escapes don't leak into JSON responses that machine clients must parse.
  const useColor = opts.color !== false;
  const C = {
    reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  };
  const fmt = (c: keyof typeof C, t: string) => useColor ? `${C[c]}${t}${C.reset}` : t;
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath} (proposed fix)`, `@@ -${startLine},${original.length} +${startLine},${replacement.length} @@`];
  for (const l of original) lines.push(fmt('red', `- ${l}`));
  for (const l of replacement) lines.push(fmt('green', `+ ${l}`));
  return lines.join('\n');
}

export async function generateFix(finding: Finding, engine: ReviewEngine, cwd: string): Promise<GenerateResult> {
  // MCP handlers can pass through findings loaded from disk — validate required
  // fields rather than trusting the CLI pre-filter path.
  if (!finding.file || typeof finding.file !== 'string') {
    return { status: 'cannot_fix', reason: 'finding.file missing' };
  }
  if (typeof finding.line !== 'number' || !Number.isFinite(finding.line) || finding.line < 1) {
    return { status: 'cannot_fix', reason: 'finding.line missing or invalid' };
  }

  const absPath = path.resolve(cwd, finding.file);
  let fileLines: string[];
  try {
    fileLines = fs.readFileSync(absPath, 'utf8').split('\n');
  } catch {
    return { status: 'cannot_fix', reason: 'file not readable' };
  }

  const lineIdx = finding.line - 1;
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
