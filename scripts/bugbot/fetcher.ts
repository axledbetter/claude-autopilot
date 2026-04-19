/**
 * Fetches bugbot review comments from GitHub.
 *
 * Customize:
 * - BUGBOT_AUTHOR: change if you use a different review bot (CodeRabbit, Greptile, etc.)
 * - parseSeverity: adapt to match your bot's comment format
 */

import { execFileSync } from 'child_process';
import { BugbotComment } from './types';

const BUGBOT_AUTHOR = 'cursor[bot]';

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

function parseSeverity(body: string): BugbotComment['severity'] {
  const lower = body.toLowerCase();
  if (lower.includes('high') || lower.includes('critical')) return 'HIGH';
  if (lower.includes('medium') || lower.includes('moderate')) return 'MEDIUM';
  if (lower.includes('low')) return 'LOW';
  return 'UNKNOWN';
}

export function getCurrentPrNumber(): number | null {
  const result = runSafe('gh', ['pr', 'view', '--json', 'number', '-q', '.number']);
  if (!result) return null;
  const n = parseInt(result.trim(), 10);
  return isNaN(n) ? null : n;
}

export function getHeadSha(): string {
  const result = runSafe('git', ['rev-parse', 'HEAD']);
  return result ? result.trim() : '';
}

export function fetchBugbotComments(prNumber: number): BugbotComment[] {
  const repo = getRepo();
  if (!repo) return [];

  const output = runSafe('gh', [
    'api', `repos/${repo}/pulls/${prNumber}/comments`,
    '--jq', `.[] | select(.user.login == "${BUGBOT_AUTHOR}") | @json`,
  ]);

  if (!output) return [];

  const comments: BugbotComment[] = [];
  for (const line of output.trim().split('\n').filter(Boolean)) {
    try {
      const raw = JSON.parse(line);
      comments.push({
        id: raw.id,
        path: raw.path || '',
        line: raw.line ?? raw.original_line,
        body: raw.body || '',
        severity: parseSeverity(raw.body || ''),
        url: raw.html_url || '',
      });
    } catch { /* skip malformed */ }
  }
  return comments;
}

export function checkForHumanDismissal(prNumber: number, commentId: number): boolean {
  const repo = getRepo();
  if (!repo) return false;

  // Check if there's a human reply to this comment confirming it's a false positive
  const output = runSafe('gh', [
    'api', `repos/${repo}/pulls/${prNumber}/comments`,
    '--jq', `.[] | select(.in_reply_to_id == ${commentId}) | select(.user.type != "Bot") | .body`,
  ]);

  if (!output || !output.trim()) return false;
  const lower = output.toLowerCase();
  return lower.includes('false positive') || lower.includes('not an issue') || lower.includes('intentional') || lower.includes('wontfix');
}
