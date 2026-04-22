import { runSafe } from '../core/shell.ts';
import type { Finding } from '../core/findings/types.ts';

const REVIEW_MARKER = '<!-- guardrail-inline -->';

function getRepoNwo(cwd: string): string | null {
  const raw = runSafe('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
  return raw ? raw.trim() : null;
}

/** True when a review with our marker already exists on this PR (avoids duplicates on re-runs). */
function findExistingReviewId(pr: number, nwo: string, cwd: string): number | null {
  const raw = runSafe('gh', [
    'api', `repos/${nwo}/pulls/${pr}/reviews`,
    '--jq', `[.[] | select(.body | startswith("${REVIEW_MARKER}")) | .id] | first`,
  ], { cwd });
  if (!raw) return null;
  const n = parseInt(raw.trim(), 10);
  return isNaN(n) ? null : n;
}

export interface PostReviewCommentsResult {
  posted: number;
  skipped: number; // findings with no line number
}

/**
 * Posts (or re-submits) a PR review with inline comments for each finding
 * that has a file + line number. Findings without line numbers are skipped.
 * Re-runs dismiss the previous autopilot review first to avoid stacking.
 */
export async function postReviewComments(
  pr: number,
  findings: Finding[],
  cwd: string,
): Promise<PostReviewCommentsResult> {
  const nwo = getRepoNwo(cwd);
  if (!nwo) throw new Error('Could not determine repository name — is gh authenticated?');

  const commentable = findings.filter(
    f => f.line !== undefined && f.file && f.file !== '<unspecified>' && f.file !== '<pipeline>',
  );
  const skipped = findings.length - commentable.length;

  if (commentable.length === 0) return { posted: 0, skipped };

  // Dismiss existing review so we don't stack on re-runs
  const existingId = findExistingReviewId(pr, nwo, cwd);
  if (existingId) {
    runSafe('gh', [
      'api', `repos/${nwo}/pulls/${pr}/reviews/${existingId}/dismissals`,
      '--method', 'PUT',
      '--field', 'message=Superseded by updated guardrail review',
    ], { cwd });
  }

  // Build review body
  const body = [
    REVIEW_MARKER,
    `**Autopilot** found ${commentable.length} inline finding${commentable.length !== 1 ? 's' : ''}.`,
  ].join('\n');

  // Build comments array as JSON
  const comments = commentable.map(f => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: formatFindingBody(f),
  }));

  // gh api doesn't support array fields well via --field, use --input with JSON
  const payload = JSON.stringify({ body, event: 'COMMENT', comments });
  const result = runSafe('gh', [
    'api', `repos/${nwo}/pulls/${pr}/reviews`,
    '--method', 'POST',
    '--input', '-',
  ], { cwd, input: payload });

  if (!result) throw new Error('Failed to post review — gh api returned no output');

  return { posted: commentable.length, skipped };
}

function formatFindingBody(f: Finding): string {
  const sev = f.severity === 'critical' ? '🚨 **CRITICAL**'
            : f.severity === 'warning'  ? '⚠️ **Warning**'
            : '💡 **Note**';
  const lines = [`${sev} — ${f.message}`];
  if (f.suggestion) lines.push(`\n> **Suggestion:** ${f.suggestion}`);
  lines.push(`\n*[@delegance/guardrail](https://github.com/axledbetter/guardrail)*`);
  return lines.join('');
}
