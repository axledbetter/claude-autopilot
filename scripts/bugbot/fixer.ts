/**
 * Auto-fix engine — applies fixes for triaged bugs using the Claude CLI.
 *
 * Customize:
 * - PROTECTED_PATHS: files/dirs where auto-fix is blocked regardless of confidence
 * - The fix prompt: adapt to your coding standards
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { BugbotComment, TriageResult } from './types';

// Files/dirs where auto-fix is never applied — require human review
const PROTECTED_PATHS = [
  'auth', 'billing', 'payment', 'stripe', 'middleware',
  'data/deltas', 'migrations', 'lib/supabase',
];

export interface FixResult {
  commentId: number;
  success: boolean;
  commitSha?: string;
}

function runSafe(cmd: string, args: string[], opts?: { input?: string; timeout?: number }): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      input: opts?.input,
      stdio: opts?.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeout ?? 60000,
    }) as string;
  } catch {
    return null;
  }
}

function isProtected(filePath: string): boolean {
  return PROTECTED_PATHS.some(p => filePath.includes(p));
}

function buildFixPrompt(comment: BugbotComment): string {
  return `Fix the following issue in ${comment.path}:

${comment.body}

Requirements:
- Apply the minimal fix that addresses the specific issue
- Do not change anything else — no refactoring, no style changes
- The fix must not break existing tests`;
}

function applyFix(comment: BugbotComment, verbose: boolean): FixResult {
  if (isProtected(comment.path)) {
    if (verbose) console.log(`[bugbot] Skipping auto-fix for protected path: ${comment.path}`);
    return { commentId: comment.id, success: false };
  }

  const prompt = buildFixPrompt(comment);
  const result = runSafe('claude', ['-p', '--allowedTools', 'Edit,Read', '--max-turns', '5'], { input: prompt, timeout: 90000 });

  if (!result) {
    if (verbose) console.warn(`[bugbot] Fix failed for comment ${comment.id}`);
    return { commentId: comment.id, success: false };
  }

  // Verify tests still pass
  const testDir = `${path.dirname(comment.path)}/__tests__/`;
  const testResult = runSafe('npx', ['jest', testDir, '--silent', '--passWithNoTests'], { timeout: 60000 });

  if (testResult === null) {
    // Tests failed — revert
    runSafe('git', ['checkout', comment.path]);
    if (verbose) console.warn(`[bugbot] Fix for comment ${comment.id} reverted — tests failed`);
    return { commentId: comment.id, success: false };
  }

  // Commit the fix
  runSafe('git', ['add', comment.path]);
  const commitResult = runSafe('git', ['commit', '-m', `fix: address bugbot finding in ${path.basename(comment.path)}`]);

  if (!commitResult) {
    return { commentId: comment.id, success: false };
  }

  const sha = runSafe('git', ['rev-parse', 'HEAD'])?.trim();
  if (verbose) console.log(`[bugbot] Fixed comment ${comment.id} → ${sha?.slice(0, 8)}`);

  return { commentId: comment.id, success: true, commitSha: sha };
}

export function applyFixes(comments: BugbotComment[], triageResults: TriageResult[], verbose: boolean): FixResult[] {
  const results: FixResult[] = [];

  for (const triage of triageResults) {
    if (triage.action !== 'auto_fix') continue;
    const comment = comments.find(c => c.id === triage.commentId);
    if (!comment) continue;
    results.push(applyFix(comment, verbose));
  }

  return results;
}
