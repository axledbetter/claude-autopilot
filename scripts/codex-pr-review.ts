#!/usr/bin/env tsx
/**
 * Codex PR Review — runs Codex 5.3 on PR diff and posts as GitHub comment.
 *
 * Usage:
 *   npx tsx scripts/codex-pr-review.ts <pr-number>
 *   npx tsx scripts/codex-pr-review.ts 346
 *
 * Requires: OPENAI_API_KEY, gh CLI authenticated
 */

import * as fs from 'fs';
import { run, runSafe } from './validate/exec-utils';

async function main() {
  const prNumber = process.argv[2];
  if (!prNumber || isNaN(Number(prNumber))) {
    console.error('Usage: npx tsx scripts/codex-pr-review.ts <pr-number>');
    process.exit(1);
  }

  console.log(`[codex-pr-review] Reviewing PR #${prNumber}...`);

  // 1. Get the PR diff
  const diff = runSafe('gh', ['pr', 'diff', prNumber, '--patch']);
  if (!diff) {
    console.error('[codex-pr-review] Failed to fetch PR diff');
    process.exit(1);
  }

  // 2. Get PR title and body for context
  const prInfo = runSafe('gh', ['pr', 'view', prNumber, '--json', 'title,body', '--jq', '.title + "\\n\\n" + .body']);

  // 3. Get list of changed files
  const changedFiles = runSafe('gh', ['pr', 'diff', prNumber, '--name-only']);

  // 4. Build review input — truncate diff to avoid token limits
  const maxDiffLength = 15000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n\n... (diff truncated for review)'
    : diff;

  const reviewInput = [
    '# PR Review Request',
    '',
    `## PR #${prNumber}: ${prInfo?.split('\n')[0] || 'Unknown'}`,
    '',
    '## Changed Files',
    changedFiles || '(unable to list)',
    '',
    '## Diff',
    '```diff',
    truncatedDiff,
    '```',
    '',
    '## Instructions',
    'Review this PR diff for:',
    '1. Security issues (RLS bypass, SQL injection, missing auth, hardcoded secrets)',
    '2. Logic bugs (race conditions, null derefs, off-by-one)',
    '3. Data integrity (missing Weaviate tenant, wrong Supabase client, missing company_id validation)',
    '4. Architecture concerns (wrong patterns, missing error handling, over-engineering)',
    '',
    'Focus on CRITICAL and WARNING findings. Skip style/formatting NOTEs.',
  ].join('\n');

  const tmpFile = `/tmp/codex-pr-review-${prNumber}.md`;
  fs.writeFileSync(tmpFile, reviewInput);

  try {
    // 5. Run Codex review
    console.log('[codex-pr-review] Sending to Codex 5.3...');
    const codexOutput = runSafe('npx', ['tsx', 'scripts/codex-review.ts', tmpFile], { timeout: 120000 });

    if (!codexOutput) {
      console.error('[codex-pr-review] Codex review failed');
      process.exit(1);
    }

    // 6. Build GitHub comment
    const comment = [
      '## Codex 5.3 Review',
      '',
      codexOutput.trim(),
      '',
      '---',
      '_Automated review by Codex 5.3 via `scripts/codex-pr-review.ts`_',
    ].join('\n');

    // 7. Post as PR comment
    console.log('[codex-pr-review] Posting review comment...');
    try {
      run('gh', ['pr', 'comment', prNumber, '--body', comment]);
      console.log(`[codex-pr-review] Review posted to PR #${prNumber}`);
    } catch (error) {
      console.error('[codex-pr-review] Failed to post comment, outputting to stdout instead:');
      console.log(comment);
    }
  } finally {
    // Always clean up temp file, even on early exit
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

main().catch(err => {
  console.error('[codex-pr-review] Fatal:', err);
  process.exit(1);
});
