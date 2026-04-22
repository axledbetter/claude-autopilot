import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { Finding } from '../core/findings/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

const CONTEXT_LINES = 30;

export interface ExplainCommandOptions {
  cwd?: string;
  configPath?: string;
  target?: string;   // "file:line" or finding index (1-based) or finding id
  index?: number;    // 1-based index into cached findings
}

function pickFinding(findings: Finding[], target: string): Finding | null {
  // Try "file:line" format
  const colonIdx = target.lastIndexOf(':');
  if (colonIdx > 0) {
    const file = target.slice(0, colonIdx);
    const line = parseInt(target.slice(colonIdx + 1), 10);
    if (!isNaN(line)) {
      const match = findings.find(f => f.file.endsWith(file) && f.line === line);
      if (match) return match;
    }
  }
  // Try numeric index (1-based)
  const n = parseInt(target, 10);
  if (!isNaN(n) && n >= 1 && n <= findings.length) return findings[n - 1]!;
  // Try finding id prefix
  const byId = findings.find(f => f.id.startsWith(target));
  if (byId) return byId;
  return null;
}

export async function runExplain(options: ExplainCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  const findings = loadCachedFindings(cwd);
  if (findings.length === 0) {
    console.log(fmt('yellow', '[explain] No cached findings — run `guardrail run` or `guardrail scan` first.'));
    return 0;
  }

  let finding: Finding | null = null;

  if (options.target) {
    finding = pickFinding(findings, options.target);
    if (!finding) {
      console.error(fmt('red', `[explain] No finding matching "${options.target}"`));
      console.error(fmt('dim', '  Use file:line, finding index (1–' + findings.length + '), or rule id'));
      return 1;
    }
  } else {
    // No target — list findings and prompt
    console.log(`\n${fmt('bold', '[guardrail explain]')} ${findings.length} cached finding${findings.length !== 1 ? 's' : ''}:\n`);
    findings.forEach((f, i) => {
      const sev = f.severity === 'critical' ? fmt('red', 'CRIT') : f.severity === 'warning' ? fmt('yellow', 'WARN') : fmt('dim', 'NOTE');
      const loc = f.file !== '<unspecified>' ? fmt('dim', ` ${f.file}${f.line ? `:${f.line}` : ''}`) : '';
      console.log(`  ${String(i + 1).padStart(2)}. [${sev}]${loc} ${f.message.slice(0, 70)}`);
    });
    console.log(fmt('dim', '\n  Run: guardrail explain <index|file:line|rule-id>\n'));
    return 0;
  }

  // Load engine
  let engine;
  try {
    const config = fs.existsSync(configPath) ? await loadConfig(configPath) : { configVersion: 1 as const };
    const ref = typeof config.reviewEngine === 'string' ? config.reviewEngine
      : (config.reviewEngine?.adapter ?? 'auto');
    engine = await loadAdapter({ point: 'review-engine', ref,
      options: typeof config.reviewEngine === 'object' ? config.reviewEngine.options : undefined });
  } catch (err) {
    console.error(fmt('red', `[explain] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // Read file context
  let codeContext = '';
  if (finding.file && finding.file !== '<unspecified>' && finding.file !== '<pipeline>' && finding.line) {
    const absPath = path.resolve(cwd, finding.file);
    if (fs.existsSync(absPath)) {
      const lines = fs.readFileSync(absPath, 'utf8').split('\n');
      const lineIdx = finding.line - 1;
      const start = Math.max(0, lineIdx - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, lineIdx + CONTEXT_LINES);
      const numbered = lines.slice(start, end + 1).map((l, i) => {
        const n = start + i + 1;
        return `${n === finding!.line ? '>>>' : '   '} ${String(n).padStart(4)}: ${l}`;
      }).join('\n');
      codeContext = `\n\nRelevant code from ${finding.file} (>>> marks the finding):\n\`\`\`\n${numbered}\n\`\`\``;
    }
  }

  const prompt = [
    `I have a code finding I need help understanding:`,
    ``,
    `Rule: ${finding.id}`,
    `Severity: ${finding.severity.toUpperCase()}`,
    `File: ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
    `Message: ${finding.message}`,
    finding.suggestion ? `Initial suggestion: ${finding.suggestion}` : '',
    codeContext,
    ``,
    `Please provide:`,
    `1. **Why this is a problem** — explain the root cause and real-world risk`,
    `2. **How to fix it** — concrete code-level remediation steps`,
    `3. **Example** — a before/after code snippet if applicable`,
    `4. **When to ignore it** — legitimate cases where this finding can be suppressed`,
  ].filter(s => s !== undefined && s !== null).join('\n');

  console.log(`\n${fmt('bold', '[guardrail explain]')} ${fmt('dim', `${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.id}`)}\n`);

  try {
    const output = await engine.review({ content: prompt, kind: 'file-batch' });
    // Print the raw explanation text (findings array will be empty for this prompt style)
    const text = output.rawOutput.trim();
    console.log(text);
    console.log('');
  } catch (err) {
    console.error(fmt('red', `[explain] LLM error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  return 0;
}
