#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';

// Load .env.local / .env so OPENAI_API_KEY etc. are available without shell export
const ENV_FILES = ['.env.local', '.env.dev', '.env.development', '.env'];
for (const f of ENV_FILES) {
  const p = path.join(process.cwd(), f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!process.env[key]) {
      process.env[key] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  break;
}

import { loadConfig } from '../core/config/loader.ts';
import { loadRulesFromConfig } from '../core/static-rules/registry.ts';
import { resolvePreset } from '../core/config/preset-resolver.ts';
import { mergeConfigs } from '../core/config/preset-resolver.ts';
import { loadAdapter } from '../adapters/loader.ts';
import { runGuardrail } from '../core/pipeline/run.ts';
import { resolveGitTouchedFiles } from '../core/git/touched-files.ts';
import type { RunInput } from '../core/pipeline/run.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import { fileURLToPath } from 'node:url';
import { toSarif } from '../formatters/sarif.ts';
import { toJUnit } from '../formatters/junit.ts';
import { loadTriage, filterTriaged } from '../core/persist/triage.ts';
import { emitAnnotations } from '../formatters/github-annotations.ts';
import { detectStack } from '../core/detect/stack.ts';
import { detectProtectedPaths } from '../core/detect/protected-paths.ts';
import { detectGitContext } from '../core/detect/git-context.ts';
import { detectWorkspaces, mapFilesToWorkspaces } from '../core/detect/workspaces.ts';
import { detectProject } from './detector.ts';
import { detectPrNumber, formatComment, postPrComment } from './pr-comment.ts';
import { postReviewComments } from './pr-review-comments.ts';
import { loadIgnoreRules, parseConfigIgnore, applyIgnoreRules } from '../core/ignore/index.ts';
import { loadCachedFindings, saveCachedFindings, filterNewFindings } from '../core/persist/findings-cache.ts';
import { loadBaseline, filterBaselined } from '../core/persist/baseline.ts';
import { appendCostLog } from '../core/persist/cost-log.ts';
import { postCommitStatus, resolveCommitSha } from '../adapters/vcs-host/commit-status.ts';

function computeExitCode(findings: { severity: string }[], failOn: string): number {
  if (failOn === 'none') return 0;
  const fail = failOn === 'warning' ? ['critical', 'warning']
    : failOn === 'note' ? ['critical', 'warning', 'note']
    : ['critical'];
  return findings.some(f => fail.includes(f.severity)) ? 1 : 0;
}

function readToolVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function fmt(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

export interface RunCommandOptions {
  cwd?: string;
  configPath?: string;
  base?: string;        // git base ref (default HEAD~1)
  files?: string[];     // explicit file list (skips git detection)
  dryRun?: boolean;     // skip review, print what would run
  diff?: boolean;           // use diff strategy (send git hunks instead of full files)
  delta?: boolean;          // only report findings not present in last run's baseline
  newOnly?: boolean;        // only report findings not in committed .guardrail-baseline.json
  failOn?: 'critical' | 'warning' | 'note' | 'none'; // severity threshold for exit 1
  inlineComments?: boolean; // post per-line review comments on the PR diff
  format?: 'text' | 'sarif' | 'junit';
  outputPath?: string;
  postComments?: boolean; // post/update summary comment on the open PR
  skipReview?: boolean;  // skip tests and review phases (static rules only)
}

/**
 * Returns an exit code (0 = pass/warn, 1 = fail/error).
 * Never calls process.exit directly — caller decides when to exit.
 */
export async function runCommand(options: RunCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  // Load + merge config (graceful zero-config fallback)
  let config: GuardrailConfig;
  if (!fs.existsSync(configPath)) {
    console.log(fmt('dim', `[run] No guardrail.config.yaml found — using defaults. Run \`npx guardrail setup\` to configure.`));
    config = { configVersion: 1, reviewEngine: { adapter: 'auto' }, testCommand: null };
  } else {
    try {
      const userConfig = await loadConfig(configPath);
      if (userConfig.preset) {
        const preset = await resolvePreset(userConfig.preset);
        config = mergeConfigs(preset.config, userConfig);
      } else {
        config = userConfig;
      }
    } catch (err) {
      console.error(fmt('red', `[run] Config error: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
  }

  // Fill in missing config fields from auto-detection (track what was auto-detected for logging)
  const autoDetected: string[] = [];

  if (!config.stack) {
    const detected = detectStack(cwd);
    if (detected) { config = { ...config, stack: detected }; autoDetected.push(`stack: ${detected}`); }
  }
  if (!config.protectedPaths || config.protectedPaths.length === 0) {
    const detected = detectProtectedPaths(cwd);
    if (detected.length > 0) {
      config = { ...config, protectedPaths: detected };
      autoDetected.push(`protected: ${detected.slice(0, 3).join(', ')}${detected.length > 3 ? ` +${detected.length - 3} more` : ''}`);
    }
  }
  if (config.testCommand === undefined) {
    const detected = detectProject(cwd).testCommand;
    config = { ...config, testCommand: detected };
    autoDetected.push(`test: ${detected}`);
  }

  // Monorepo workspace detection
  const workspaces = detectWorkspaces(cwd);
  if (workspaces && workspaces.length > 0) {
    autoDetected.push(`workspaces: ${workspaces.length} (${workspaces.map(w => w.name).slice(0, 3).join(', ')}${workspaces.length > 3 ? ` +${workspaces.length - 3} more` : ''})`);
  }

  const gitCtx = detectGitContext(cwd);

  // Resolve touched files
  const touchedFiles = options.files ?? resolveGitTouchedFiles({ cwd, base: options.base });
  if (touchedFiles.length === 0) {
    console.log(fmt('yellow', '[run] No changed files detected — nothing to review.'));
    console.log(fmt('dim', '      Pass --base <ref> to compare against a different branch/commit.'));
    return 0;
  }

  console.log(`\n${fmt('bold', '[guardrail run]')} ${fmt('dim', configPath)}`);
  console.log(`${fmt('dim', `  ${touchedFiles.length} changed file(s):`)} ${touchedFiles.slice(0, 5).join(', ')}${touchedFiles.length > 5 ? ` … +${touchedFiles.length - 5} more` : ''}`);
  if (gitCtx.summary) {
    console.log(fmt('dim', `  ${gitCtx.summary}`));
  }
  if (autoDetected.length > 0) {
    console.log(fmt('dim', `  auto-detected: ${autoDetected.join(' | ')}`));
  }

  if (options.dryRun) {
    console.log(fmt('yellow', '\n[run] Dry run — skipping pipeline execution.\n'));
    return 0;
  }

  // Load review engine (optional — skip gracefully if no API key configured)
  let reviewEngine: ReviewEngine | undefined;
  if (config.reviewEngine) {
    const ref = typeof config.reviewEngine === 'string' ? config.reviewEngine : config.reviewEngine.adapter;
    const hasAnyKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
    if (!hasAnyKey && ['auto', 'claude', 'gemini', 'codex', 'openai-compatible'].includes(ref)) {
      console.log(fmt('yellow', '\n  [run] No LLM API key — set one of:'));
      console.log(fmt('dim',    '         ANTHROPIC_API_KEY  https://console.anthropic.com/'));
      console.log(fmt('dim',    '         OPENAI_API_KEY     https://platform.openai.com/api-keys'));
      console.log(fmt('dim',    '         GEMINI_API_KEY     https://aistudio.google.com/app/apikey'));
      console.log(fmt('dim',    '         GROQ_API_KEY       https://console.groq.com/keys  (fast free tier)\n'));
    } else {
      try {
        reviewEngine = await loadAdapter<ReviewEngine>({
          point: 'review-engine',
          ref,
          options: typeof config.reviewEngine === 'string' ? undefined : config.reviewEngine.options,
        });
      } catch (err) {
        console.error(fmt('yellow', `  [run] Could not load review engine (${ref}): ${err instanceof Error ? err.message : String(err)} — skipping`));
      }
    }
  }

  // Load static rules from config
  const staticRules = config.staticRules && config.staticRules.length > 0
    ? await loadRulesFromConfig(config.staticRules)
    : [];

  // Apply --diff flag: override reviewStrategy to 'diff'
  if (options.diff && config.reviewStrategy !== 'diff') {
    config = { ...config, reviewStrategy: 'diff' };
  }

  // Pre-run cost estimate
  if (config.cost?.estimateBeforeRun) {
    const totalChars = touchedFiles.reduce((sum, f) => {
      try { return sum + fs.statSync(f).size; } catch { return sum; }
    }, 0);
    const estTokens = Math.round(totalChars / 4);
    const estCost = estTokens / 1_000_000 * 3.0; // rough: $3/M tokens (Sonnet)
    const cap = config.cost?.maxPerRun;
    console.log(fmt('dim', `  [run] estimated: ~${estTokens.toLocaleString()} tokens, ~$${estCost.toFixed(4)}`
      + (cap ? ` (cap: $${cap})` : '')));
  }

  // Execute pipeline
  const input: RunInput = {
    touchedFiles,
    config,
    reviewEngine,
    staticRules,
    cwd,
    gitSummary: gitCtx.summary ?? undefined,
    base: options.base,
    skipReview: options.skipReview,
  };

  // Post pending commit status (best-effort — never fatal)
  const commitSha = resolveCommitSha(cwd);
  if (commitSha) {
    postCommitStatus({ sha: commitSha, state: 'pending', description: `Reviewing ${touchedFiles.length} file(s)…`, cwd });
  }

  console.log('');
  const result = await runGuardrail(input);

  // Apply .guardrail-ignore + config ignore: rules
  const ignoreRules = [...loadIgnoreRules(cwd), ...parseConfigIgnore(config.ignore)];
  if (ignoreRules.length > 0) {
    const before = result.allFindings.length;
    result.allFindings = applyIgnoreRules(result.allFindings, ignoreRules);
    for (const phase of result.phases) {
      phase.findings = applyIgnoreRules(phase.findings, ignoreRules);
    }
    const suppressed = before - result.allFindings.length;
    if (suppressed > 0) {
      console.log(fmt('dim', `  [run] ${suppressed} finding${suppressed !== 1 ? 's' : ''} suppressed by .guardrail-ignore`));
    }
  }

  // Delta mode: filter to only new findings vs last run's cache, then persist
  if (options.delta) {
    const cached = loadCachedFindings(cwd);
    const before = result.allFindings.length;
    result.allFindings = filterNewFindings(result.allFindings, cached);
    for (const phase of result.phases) {
      phase.findings = filterNewFindings(phase.findings, cached);
    }
    const existing = before - result.allFindings.length;
    if (existing > 0) {
      console.log(fmt('dim', `  [run] ${existing} pre-existing finding${existing !== 1 ? 's' : ''} hidden (--delta mode)`));
    }
  }

  // --new-only / policy.newOnly: filter against committed .guardrail-baseline.json
  const policy = config.policy ?? {};
  const newOnly = options.newOnly ?? policy.newOnly ?? false;
  if (newOnly) {
    const baseline = loadBaseline(cwd, policy.baselinePath);
    if (baseline) {
      const { newFindings, baselinedCount } = filterBaselined(result.allFindings, baseline);
      result.allFindings = newFindings;
      for (const phase of result.phases) {
        phase.findings = filterBaselined(phase.findings, baseline).newFindings;
      }
      if (baselinedCount > 0) {
        console.log(fmt('dim', `  [run] ${baselinedCount} baselined finding${baselinedCount !== 1 ? 's' : ''} suppressed (--new-only)`));
      }
    } else {
      console.log(fmt('yellow', '  [run] --new-only: no .guardrail-baseline.json found — showing all findings'));
      console.log(fmt('dim',    '         Run `guardrail baseline create` after first scan to pin the baseline'));
    }
  }

  // Triage filter: suppress accepted-risk / false-positive findings
  const triageStore = loadTriage(cwd);
  if (triageStore.entries.length > 0) {
    const { active, triageCount } = filterTriaged(result.allFindings, triageStore);
    if (triageCount > 0) {
      result.allFindings = active;
      for (const phase of result.phases) {
        phase.findings = filterTriaged(phase.findings, triageStore).active;
      }
      console.log(fmt('dim', `  [run] ${triageCount} triaged finding${triageCount !== 1 ? 's' : ''} suppressed (accepted-risk / false-positive)`));
    }
  }

  // Always persist the unfiltered findings as the run cache
  saveCachedFindings(cwd, result.allFindings);

  // Append to per-run cost log
  const reviewPhase = result.phases.find(p => p.phase === 'review') as { usage?: { input: number; output: number } } | undefined;
  appendCostLog(cwd, {
    timestamp: new Date().toISOString(),
    files: touchedFiles.length,
    inputTokens: reviewPhase?.usage?.input ?? 0,
    outputTokens: reviewPhase?.usage?.output ?? 0,
    costUSD: result.totalCostUSD ?? 0,
    durationMs: result.durationMs,
  });

  // emitAnnotations is a no-op unless GITHUB_ACTIONS=true
  emitAnnotations(result.allFindings);

  // Write SARIF output if requested
  if (options.format === 'sarif' && options.outputPath) {
    const sarif = toSarif(result, { toolVersion: readToolVersion(), cwd });
    fs.mkdirSync(path.dirname(path.resolve(options.outputPath)), { recursive: true });
    fs.writeFileSync(options.outputPath, JSON.stringify(sarif, null, 2), 'utf8');
    console.log(fmt('dim', `[run] SARIF written to ${options.outputPath}`));
  }

  // Write JUnit XML output if requested
  if (options.format === 'junit' && options.outputPath) {
    const junit = toJUnit(result);
    fs.mkdirSync(path.dirname(path.resolve(options.outputPath)), { recursive: true });
    fs.writeFileSync(options.outputPath, junit, 'utf8');
    console.log(fmt('dim', `[run] JUnit XML written to ${options.outputPath}`));
  }

  // Post inline PR review comments if requested
  if (options.inlineComments) {
    const pr = detectPrNumber(cwd);
    if (!pr) {
      console.log(fmt('yellow', '  [run] --inline-comments: no open PR found — skipping'));
    } else {
      try {
        const { posted, skipped } = await postReviewComments(pr, result.allFindings, cwd);
        console.log(fmt('dim', `  [run] PR #${pr} inline review: ${posted} comment${posted !== 1 ? 's' : ''} posted${skipped > 0 ? `, ${skipped} skipped (no line number)` : ''}`));
      } catch (err) {
        console.error(fmt('yellow', `  [run] Failed to post inline comments: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  // Post PR comment if requested
  if (options.postComments) {
    const pr = detectPrNumber(cwd);
    if (!pr) {
      console.log(fmt('yellow', '  [run] --post-comments: no open PR found — skipping comment'));
    } else {
      try {
        const body = formatComment(result, config, gitCtx, touchedFiles.length);
        const { action } = await postPrComment(pr, body, cwd);
        console.log(fmt('dim', `  [run] PR #${pr} comment ${action}`));
      } catch (err) {
        console.error(fmt('yellow', `  [run] Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  // Print phase summaries
  for (const phase of result.phases) {
    const icon = phase.status === 'pass' ? fmt('green', '✓') :
                 phase.status === 'skip' ? fmt('dim', '–') :
                 phase.status === 'warn' ? fmt('yellow', '!') : fmt('red', '✗');
    const phaseLabel = phase.phase.padEnd(14);
    const findingCount = phase.findings.length;
    const extra = findingCount > 0 ? fmt('dim', ` (${findingCount} finding${findingCount !== 1 ? 's' : ''})`) : '';
    const dur = 'durationMs' in phase ? fmt('dim', ` ${phase.durationMs}ms`) : '';
    console.log(`  ${icon}  ${phaseLabel}${extra}${dur}`);

    // Print critical/warning findings inline
    for (const f of phase.findings) {
      if (f.severity === 'critical' || f.severity === 'warning') {
        const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING ');
        console.log(`       ${sev}  ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `                ${f.suggestion}`));
      }
    }
  }

  // Cost summary
  if (result.totalCostUSD !== undefined) {
    console.log(`\n  ${fmt('dim', `cost: $${result.totalCostUSD.toFixed(4)}`)}  ${fmt('dim', `${result.durationMs}ms total`)}`);
  } else {
    console.log(`\n  ${fmt('dim', `${result.durationMs}ms total`)}`);
  }

  // Post final commit status
  if (commitSha) {
    const critical = result.allFindings.filter(f => f.severity === 'critical').length;
    const warnings = result.allFindings.filter(f => f.severity === 'warning').length;
    const state = result.status === 'fail' ? 'failure' : 'success';
    const desc = result.status === 'pass'
      ? 'All checks passed'
      : result.status === 'warn'
        ? `Passed with ${warnings} warning${warnings !== 1 ? 's' : ''}`
        : `${critical} critical finding${critical !== 1 ? 's' : ''}`;
    postCommitStatus({ sha: commitSha, state, description: desc, cwd });
  }

  // Final verdict — apply policy.failOn threshold
  const failOn = options.failOn ?? policy.failOn ?? 'critical';
  const exitCode = computeExitCode(result.allFindings, failOn);

  console.log('');
  if (exitCode === 0 && result.status !== 'pass') {
    const reason = failOn === 'none' ? ' (policy: fail-on=none)' : ` (policy: fail-on=${failOn})`;
    console.log(fmt('yellow', `[run] ! Passed with findings${reason}\n`));
  } else if (result.status === 'pass') {
    console.log(fmt('green', '[run] ✓ All phases passed\n'));
  } else if (result.status === 'warn') {
    console.log(fmt('yellow', '[run] ! Passed with warnings\n'));
  } else {
    console.log(fmt('red', '[run] ✗ Pipeline failed — see findings above\n'));
  }
  return exitCode;
}
