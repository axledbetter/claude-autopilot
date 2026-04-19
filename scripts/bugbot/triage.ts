/**
 * Triage engine — determines the action for each bugbot comment.
 *
 * Customize:
 * - CONFIDENCE_THRESHOLDS: tune for your risk tolerance
 * - The triage prompt: adapt to your codebase and review style
 *
 * Decision matrix:
 * | Verdict      | Confidence | Action        |
 * |--------------|------------|---------------|
 * | real_bug     | >= 85%     | auto_fix      |
 * | real_bug     | 60-84%     | propose_patch |
 * | real_bug     | < 60%      | ask_question  |
 * | false_positive | any      | dismiss       |
 * | low_value    | any        | dismiss       |
 */

import { execFileSync } from 'child_process';
import { BugbotComment, TriageResult } from './types';

const CONFIDENCE_THRESHOLDS = {
  autoFix: 85,
  proposePatch: 60,
};

function runSafe(cmd: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      input,
      stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    }) as string;
  } catch {
    return null;
  }
}

function buildTriagePrompt(comment: BugbotComment): string {
  return `You are triaging a code review comment from an automated reviewer.

Comment on file: ${comment.path}${comment.line ? `:${comment.line}` : ''}
Severity: ${comment.severity}

Review comment:
${comment.body}

Analyze this finding and respond with JSON only:
{
  "verdict": "real_bug" | "false_positive" | "low_value",
  "confidence": <0-100>,
  "reason": "<one sentence>",
  "action": "auto_fix" | "propose_patch" | "ask_question" | "dismiss" | "needs_human"
}

Guidelines:
- real_bug: the code actually has the described problem
- false_positive: the reviewer is wrong or the pattern is intentional
- low_value: nitpick or style issue not worth addressing
- Use needs_human for security/auth changes regardless of confidence`;
}

function parseTriageResponse(output: string): { verdict: TriageResult['verdict']; confidence: number; reason: string; action: TriageResult['action'] } | null {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function triageOne(comment: BugbotComment, verbose: boolean): TriageResult {
  const prompt = buildTriagePrompt(comment);

  // Use claude CLI for triage — lightweight, no file access needed
  const output = runSafe('claude', ['-p', '--max-turns', '1'], prompt);

  if (!output) {
    if (verbose) console.warn(`[bugbot] Triage failed for comment ${comment.id} — defaulting to needs_human`);
    return { commentId: comment.id, action: 'needs_human', verdict: 'real_bug', confidence: 0, reason: 'Triage call failed' };
  }

  const parsed = parseTriageResponse(output);
  if (!parsed) {
    return { commentId: comment.id, action: 'needs_human', verdict: 'real_bug', confidence: 0, reason: 'Could not parse triage response' };
  }

  // Apply confidence thresholds
  let action = parsed.action;
  if (parsed.verdict === 'real_bug') {
    if (parsed.confidence >= CONFIDENCE_THRESHOLDS.autoFix) action = 'auto_fix';
    else if (parsed.confidence >= CONFIDENCE_THRESHOLDS.proposePatch) action = 'propose_patch';
    else action = 'ask_question';
  } else {
    action = 'dismiss';
  }

  if (verbose) {
    console.log(`[bugbot] Comment ${comment.id}: ${parsed.verdict} (${parsed.confidence}%) → ${action}`);
  }

  return { commentId: comment.id, action, verdict: parsed.verdict, confidence: parsed.confidence, reason: parsed.reason };
}

export function triageAll(comments: BugbotComment[], verbose: boolean): TriageResult[] {
  return comments.map(c => triageOne(c, verbose));
}
