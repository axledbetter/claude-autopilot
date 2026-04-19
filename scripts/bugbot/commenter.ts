/**
 * Posts triage reply comments on GitHub PR review threads.
 */

import { execFileSync } from 'child_process';
import { BugbotComment, TriageResult } from './types';

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

function buildReplyBody(triage: TriageResult): string {
  switch (triage.action) {
    case 'auto_fix':
      return `**[bugbot]** ✅ Auto-fixed (${triage.confidence}% confidence). ${triage.reason}`;
    case 'propose_patch':
      return `**[bugbot]** 🔧 Proposing fix (${triage.confidence}% confidence): ${triage.reason}\n\n${triage.proposedPatch ?? '_See suggested changes_'}`;
    case 'ask_question':
      return `**[bugbot]** ❓ Low confidence (${triage.confidence}%): ${triage.reason} — human review needed.`;
    case 'dismiss':
      if (triage.verdict === 'false_positive') {
        return `**[bugbot]** 🙅 False positive: ${triage.reason}`;
      }
      return `**[bugbot]** ⏭️ Low-value finding skipped: ${triage.reason}`;
    case 'needs_human':
      return `**[bugbot]** 🔴 Needs human review (protected path or low confidence): ${triage.reason}`;
    default:
      return `**[bugbot]** ${triage.reason}`;
  }
}

export function postTriageReply(prNumber: number, comment: BugbotComment, triage: TriageResult): void {
  const repo = getRepo();
  if (!repo) return;

  const body = buildReplyBody(triage);

  runSafe('gh', [
    'api', `repos/${repo}/pulls/${prNumber}/comments`,
    '--method', 'POST',
    '--field', `body=${body}`,
    '--field', `in_reply_to=${comment.id}`,
  ]);
}
