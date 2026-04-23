import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import { runReviewPhase } from '../core/pipeline/review-phase.ts';
import { detectStack } from '../core/detect/stack.ts';
import { loadIgnoreRules, parseConfigIgnore, applyIgnoreRules } from '../core/ignore/index.ts';
import { saveCachedFindings } from '../core/persist/findings-cache.ts';
import type { GuardrailConfig } from '../core/config/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '.guardrail-cache', '.autopilot', '__pycache__', '.venv', 'vendor',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.cs', '.php',
  '.sql', '.sh', '.bash', '.yaml', '.yml', '.json', '.toml',
]);

function collectFiles(target: string, cwd: string): string[] {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  if (!fs.existsSync(abs)) return [];

  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];

  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }
  walk(abs);
  return results;
}

function collectAllFiles(cwd: string): string[] {
  return collectFiles(cwd, cwd);
}

export interface ScanCommandOptions {
  cwd?: string;
  configPath?: string;
  targets?: string[];   // explicit paths/dirs to scan
  all?: boolean;        // scan entire codebase
  ask?: string;         // targeted question to inject into review prompt
  focus?: 'security' | 'logic' | 'performance' | 'brand' | 'all';
  dryRun?: boolean;
}

export async function runScan(options: ScanCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config: GuardrailConfig = { configVersion: 1 };
  if (fs.existsSync(configPath)) {
    const loaded = loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // Collect files
  let files: string[];
  if (options.all) {
    files = collectAllFiles(cwd);
  } else if (options.targets && options.targets.length > 0) {
    files = options.targets.flatMap(t => collectFiles(t, cwd));
  } else {
    console.error(fmt('red', '[scan] Specify a path, --all, or use `guardrail run` for git-changed files'));
    console.error(fmt('dim', '  Examples:'));
    console.error(fmt('dim', '    guardrail scan src/auth/'));
    console.error(fmt('dim', '    guardrail scan --all'));
    console.error(fmt('dim', '    guardrail scan --ask "is there SQL injection?" src/db/'));
    return 1;
  }

  // Deduplicate
  files = [...new Set(files)];

  if (files.length === 0) {
    console.log(fmt('yellow', '[scan] No code files found at the specified path(s)'));
    return 0;
  }

  if (options.dryRun) {
    console.log(fmt('bold', `[scan] Would scan ${files.length} file(s):`));
    for (const f of files) console.log(fmt('dim', `  ${path.relative(cwd, f)}`));
    return 0;
  }

  // Auto-detect stack if not in config
  if (!config.stack) {
    config = { ...config, stack: detectStack(cwd) ?? undefined };
  }

  // Build review engine
  const hasAnyKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  if (!hasAnyKey) {
    console.error(fmt('red', '[scan] No LLM API key — set one of:'));
    console.error(fmt('dim', '         ANTHROPIC_API_KEY  https://console.anthropic.com/'));
    console.error(fmt('dim', '         OPENAI_API_KEY     https://platform.openai.com/api-keys'));
    console.error(fmt('dim', '         GEMINI_API_KEY     https://aistudio.google.com/app/apikey'));
    console.error(fmt('dim', '         GROQ_API_KEY       https://console.groq.com/keys  (fast free tier)'));
    return 1;
  }
  const engineRef = typeof config.reviewEngine === 'string' ? config.reviewEngine
    : (config.reviewEngine?.adapter ?? 'auto');
  let engine: ReviewEngine;
  try {
    engine = await loadAdapter<ReviewEngine>({
      point: 'review-engine',
      ref: engineRef,
      options: typeof config.reviewEngine === 'object' ? config.reviewEngine.options as Record<string, unknown> : undefined,
    });
  } catch (err) {
    console.error(fmt('red', `[scan] Could not load review engine: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  const focusLabel = options.focus && options.focus !== 'all' ? options.focus : null;
  const relFiles = files.map(f => path.relative(cwd, f));

  console.log('');
  const scopeDesc = options.all ? 'entire codebase' : relFiles.slice(0, 3).join(', ') + (relFiles.length > 3 ? ` +${relFiles.length - 3} more` : '');
  console.log(fmt('bold', `[guardrail scan]`) + fmt('dim', ` ${files.length} file(s) — ${scopeDesc}`));
  if (options.ask) console.log(fmt('dim', `  question: ${options.ask}`));
  if (focusLabel) console.log(fmt('dim', `  focus: ${focusLabel}`));
  console.log('');

  // Build a focused git summary / prompt context
  const focusHint = buildFocusHint(options.ask, focusLabel);

  const result = await runReviewPhase({
    touchedFiles: relFiles,
    engine,
    config,
    cwd,
    gitSummary: focusHint,
  });

  // Apply ignore rules
  const ignoreRules = [...loadIgnoreRules(cwd), ...parseConfigIgnore(config.ignore)];
  const findings = applyIgnoreRules(result.findings, ignoreRules);

  // Print results
  if (findings.length === 0 && options.ask && result.rawOutputs && result.rawOutputs.length > 0) {
    // --ask returned prose rather than structured findings — surface raw response
    console.log(fmt('cyan', `Answer:`));
    for (const raw of result.rawOutputs) {
      // Strip markdown fences and the ## Findings / ## Review Summary headers if present
      const cleaned = raw.replace(/^##\s+Review Summary\s*\n/gm, '').replace(/^##\s+Findings\s*\n/gm, '').trim();
      console.log(cleaned);
    }
    console.log('');
  } else if (findings.length === 0) {
    console.log(fmt('green', '✓ No findings'));
  } else {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const notes    = findings.filter(f => f.severity === 'note');

    if (critical.length > 0) {
      console.log(fmt('red', `🚨 ${critical.length} critical`));
      for (const f of critical) {
        const loc = f.file && f.file !== '<unspecified>' ? fmt('dim', `${f.file}${f.line ? `:${f.line}` : ''}`) + ' ' : '';
        console.log(`  ${loc}${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `    → ${f.suggestion}`));
      }
      console.log('');
    }
    if (warnings.length > 0) {
      console.log(fmt('yellow', `⚠  ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`));
      for (const f of warnings) {
        const loc = f.file && f.file !== '<unspecified>' ? fmt('dim', `${f.file}${f.line ? `:${f.line}` : ''}`) + ' ' : '';
        console.log(`  ${loc}${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `    → ${f.suggestion}`));
      }
      console.log('');
    }
    if (notes.length > 0) {
      console.log(fmt('dim', `ℹ  ${notes.length} note${notes.length !== 1 ? 's' : ''}`));
      for (const f of notes) {
        const loc = f.file && f.file !== '<unspecified>' ? `${f.file}${f.line ? `:${f.line}` : ''} ` : '';
        console.log(fmt('dim', `  ${loc}${f.message}`));
      }
      console.log('');
    }
  }

  // Persist findings so `guardrail fix` can read them
  saveCachedFindings(cwd, findings);

  if (result.costUSD !== undefined) {
    console.log(fmt('dim', `  $${result.costUSD.toFixed(4)} · ${result.durationMs}ms`));
  }

  const fixable = findings.filter(f => f.severity === 'critical' || f.severity === 'warning');
  if (fixable.length > 0) {
    console.log(fmt('dim', `  → run \`guardrail fix\` to auto-fix ${fixable.length} finding${fixable.length !== 1 ? 's' : ''}`));
  }

  return findings.some(f => f.severity === 'critical') ? 1 : 0;
}

function buildFocusHint(ask: string | undefined, focus: string | null): string {
  const parts: string[] = [];
  if (ask) {
    parts.push(
      `TARGETED QUESTION (required): The reviewer specifically wants to know: "${ask}". ` +
      `You MUST answer this question using the structured findings format. ` +
      `Even if no issues are found, output at least one ### [NOTE] finding that directly answers the question.`,
    );
  }
  if (focus === 'security') parts.push('Focus: security vulnerabilities, auth issues, injection risks, data exposure');
  if (focus === 'logic') parts.push('Focus: logic bugs, incorrect behavior, edge cases, null handling, async errors');
  if (focus === 'performance') parts.push('Focus: performance issues, N+1 queries, blocking I/O, memory leaks');
  return parts.join(' | ');
}
