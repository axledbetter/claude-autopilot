/**
 * Summary reporting — console output and GitHub PR comment.
 */

import { execFileSync } from 'child_process';
import { BugbotComment, BugbotState, TriageResult } from './types';
import { FixResult } from './fixer';

export interface SummaryRow {
  file: string;
  severity: string;
  verdict: string;
  action: string;
  status: string;
}

function runSafe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) as string;
  } catch {
    return null;
  }
}

function getRepo(): string {
  const result = runSafe('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return result ? result.trim() : '';
}

export function buildSummaryRows(
  comments: BugbotComment[],
  triageResults: TriageResult[],
  fixResults: FixResult[]
): SummaryRow[] {
  return comments.map(comment => {
    const triage = triageResults.find(t => t.commentId === comment.id);
    const fix = fixResults.find(f => f.commentId === comment.id);

    let status = triage?.action ?? 'untriaged';
    if (fix?.success) status = 'fixed';
    else if (fix && !fix.success) status = 'fix-failed';

    return {
      file: `${comment.path}${comment.line ? `:${comment.line}` : ''}`,
      severity: comment.severity,
      verdict: triage?.verdict ?? 'unknown',
      action: triage?.action ?? 'unknown',
      status,
    };
  });
}

export function printConsoleSummary(rows: SummaryRow[]): void {
  console.log('\n[bugbot] Summary:');
  for (const row of rows) {
    const icon = row.status === 'fixed' ? '✅' : row.status === 'fix-failed' ? '❌' : row.action === 'dismiss' ? '🙅' : '🔵';
    console.log(`  ${icon}  [${row.severity}] ${row.file} — ${row.verdict} → ${row.status}`);
  }
  console.log('');
}

export function formatGitHubSummary(rows: SummaryRow[]): string {
  const fixed = rows.filter(r => r.status === 'fixed').length;
  const dismissed = rows.filter(r => r.action === 'dismiss').length;
  const needsHuman = rows.filter(r => r.status === 'fix-failed' || r.action === 'needs_human').length;

  const tableRows = rows.map(r =>
    `| \`${r.file}\` | ${r.severity} | ${r.verdict} | ${r.status} |`
  ).join('\n');

  return `## [bugbot] Triage Summary

**Fixed:** ${fixed} | **Dismissed:** ${dismissed} | **Needs human:** ${needsHuman}

| File | Severity | Verdict | Status |
|------|----------|---------|--------|
${tableRows}

_Automated triage by [claude-autopilot](https://github.com/axledbetter/claude-autopilot)_`;
}

export function postSummaryComment(prNumber: number, summary: string): void {
  const repo = getRepo();
  if (!repo) return;

  runSafe('gh', [
    'issue', 'comment', String(prNumber),
    '--body', summary,
  ]);
}

export function checkMergeGate(state: BugbotState): { canMerge: boolean; blocking: string[] } {
  const blocking: string[] = [];

  for (const [commentId, entry] of Object.entries(state.processed)) {
    const isHighSeverity = entry.triageResult?.verdict === 'real_bug' &&
      (entry.triageResult?.confidence ?? 0) >= 60;

    const unresolved = entry.status === 'needs-human' ||
      (entry.status === 'ai-dismissed' && isHighSeverity);

    if (unresolved) {
      blocking.push(`Comment #${commentId}: ${entry.reason}`);
    }
  }

  return { canMerge: blocking.length === 0, blocking };
}
