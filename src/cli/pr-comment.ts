import { runSafe } from '../core/shell.ts';
import type { RunResult } from '../core/pipeline/run.ts';
import type { GuardrailConfig } from '../core/config/types.ts';
import type { GitContext } from '../core/detect/git-context.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPackageRoot } from './_pkg-root.ts';

const COMMENT_MARKER = '<!-- guardrail-review -->';

function readVersion(): string {
  try {
    const root = findPackageRoot(import.meta.url);
    if (!root) return 'unknown';
    const pkgPath = join(root, 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch { return 'unknown'; }
}

/** Detect the current open PR number via gh CLI or CI env vars. */
export function detectPrNumber(cwd: string): number | null {
  // CI env vars set by GitHub Actions
  const fromEnv = process.env.PR_NUMBER ?? process.env.GH_PR_NUMBER ?? process.env.GITHUB_PR_NUMBER;
  if (fromEnv && /^\d+$/.test(fromEnv)) return parseInt(fromEnv, 10);

  // gh CLI — works locally and in CI when gh is authenticated
  const raw = runSafe('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], { cwd });
  if (raw) {
    const n = parseInt(raw.trim(), 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

/**
 * Find the ID of a previously-posted comment matching `marker`, if any.
 * Default marker is the review-comment marker; pass a different one for
 * other comment types (e.g. deploy uses `<!-- guardrail-deploy -->`) so
 * deploy + review comments don't collide on the same PR.
 */
function findExistingCommentId(pr: number, cwd: string, marker: string = COMMENT_MARKER): number | null {
  const raw = runSafe('gh', ['api', `repos/{owner}/{repo}/issues/${pr}/comments`,
    '--jq', `[.[] | select(.body | startswith("${marker}")) | .id] | first`], { cwd });
  if (!raw) return null;
  const n = parseInt(raw.trim(), 10);
  return isNaN(n) ? null : n;
}

/** Format a RunResult into a markdown PR comment. */
export function formatComment(
  result: RunResult,
  config: GuardrailConfig,
  gitCtx: GitContext,
  touchedFileCount: number,
): string {
  const statusIcon = result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
  const statusLabel = result.status === 'pass' ? 'Passed' : result.status === 'warn' ? 'Passed with warnings' : 'Failed';

  const lines: string[] = [
    COMMENT_MARKER,
    `## ${statusIcon} Autopilot Review — ${statusLabel}`,
    '',
  ];

  // Context line
  const ctx: string[] = [];
  if (config.stack) ctx.push(`**Stack:** ${config.stack}`);
  if (gitCtx.branch) ctx.push(`**Branch:** \`${gitCtx.branch}\``);
  if (gitCtx.commitMessage) ctx.push(`**Commit:** ${gitCtx.commitMessage}`);
  ctx.push(`**Files reviewed:** ${touchedFileCount}`);
  lines.push(ctx.join(' · '), '');

  // Phase table
  lines.push('| Phase | Status | Findings |');
  lines.push('|---|:---:|:---:|');
  for (const phase of result.phases) {
    const icon = phase.status === 'pass' ? '✅' : phase.status === 'skip' ? '—' :
                 phase.status === 'warn' ? '⚠️' : '❌';
    lines.push(`| ${phase.phase} | ${icon} | ${phase.findings.length} |`);
  }
  lines.push('');

  // Findings by severity
  const critical = result.allFindings.filter(f => f.severity === 'critical');
  const warnings = result.allFindings.filter(f => f.severity === 'warning');
  const notes    = result.allFindings.filter(f => f.severity === 'note');

  if (critical.length > 0) {
    lines.push('### 🚨 Critical');
    for (const f of critical) {
      const loc = f.file !== '<unspecified>' ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` — ` : '';
      lines.push(`- ${loc}${f.message}`);
      if (f.suggestion) lines.push(`  > ${f.suggestion}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('### ⚠️ Warnings');
    for (const f of warnings) {
      const loc = f.file !== '<unspecified>' ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` — ` : '';
      lines.push(`- ${loc}${f.message}`);
      if (f.suggestion) lines.push(`  > ${f.suggestion}`);
    }
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('<details><summary>Notes</summary>\n');
    for (const f of notes) {
      const loc = f.file !== '<unspecified>' ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` — ` : '';
      lines.push(`- ${loc}${f.message}`);
    }
    lines.push('\n</details>\n');
  }

  if (result.totalCostUSD !== undefined) {
    lines.push(`*Cost: $${result.totalCostUSD.toFixed(4)} · ${result.durationMs}ms · [@delegance/guardrail](https://github.com/axledbetter/guardrail) v${readVersion()}*`);
  } else {
    lines.push(`*${result.durationMs}ms · [@delegance/guardrail](https://github.com/axledbetter/guardrail) v${readVersion()}*`);
  }

  return lines.join('\n');
}

/**
 * Post or update a comment on the given PR. Dedup is keyed on `marker`:
 * if an existing comment starting with `marker` exists, it gets PATCHed;
 * otherwise a new comment is posted. The body MUST start with the same
 * marker for upsert to work on subsequent runs.
 */
export async function postPrComment(
  pr: number,
  body: string,
  cwd: string,
  marker: string = COMMENT_MARKER,
): Promise<{ action: 'created' | 'updated'; url: string | null }> {
  const existingId = findExistingCommentId(pr, cwd, marker);

  if (existingId) {
    runSafe('gh', ['api', `repos/{owner}/{repo}/issues/comments/${existingId}`,
      '--method', 'PATCH', '--field', `body=${body}`], { cwd });
    return { action: 'updated', url: null };
  }

  const raw = runSafe('gh', ['pr', 'comment', String(pr), '--body', body], { cwd });
  // gh outputs the comment URL on success
  const url = raw?.trim() ?? null;
  return { action: 'created', url };
}

/** Re-exported for callers that want to use a non-review marker. */
export const REVIEW_COMMENT_MARKER = COMMENT_MARKER;
export const DEPLOY_COMMENT_MARKER = '<!-- guardrail-deploy -->';
