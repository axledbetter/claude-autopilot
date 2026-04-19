#!/usr/bin/env tsx

// scripts/bugbot.ts -- Main /bugbot CLI orchestrator

import { parseArgs } from 'util';
import { BugbotOptions, BugbotComment, TriageResult, ProcessedStatus } from './bugbot/types';
import { readState, writeState, createState, acquireLock, releaseLock, markProcessed, isProcessed } from './bugbot/state';
import { getCurrentPrNumber, getHeadSha, fetchBugbotComments, checkForHumanDismissal } from './bugbot/fetcher';
import { triageAll } from './bugbot/triage';
import { applyFixes, FixResult } from './bugbot/fixer';
import { postTriageReply } from './bugbot/commenter';
import { buildSummaryRows, formatGitHubSummary, printConsoleSummary, postSummaryComment, checkMergeGate } from './bugbot/reporter';
import { runSafe } from './validate/exec-utils';

// Parse CLI args
const { values } = parseArgs({
  options: {
    pr: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    rescan: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

const options: BugbotOptions = {
  prNumber: values.pr ? parseInt(values.pr, 10) : undefined,
  dryRun: !!values['dry-run'],
  rescan: !!values.rescan,
  verbose: !!values.verbose,
};

async function main() {
  // Step 0: Resolve PR number
  const prNumber = options.prNumber ?? getCurrentPrNumber();
  if (!prNumber) {
    console.error('[bugbot] Not on a PR branch and no --pr specified. Nothing to do.');
    process.exit(0);
  }

  const headSha = getHeadSha();
  console.log(`[bugbot] PR #${prNumber} | HEAD: ${headSha.slice(0, 8)} | dry-run: ${options.dryRun}`);

  // Step 1: Load or create state
  let state = readState();
  if (!state || state.prNumber !== prNumber) {
    state = createState(prNumber, headSha);
  } else if (state.headSha !== headSha) {
    // New push -- keep processed map but update headSha
    // Comments from previous SHA that bugbot re-posts on shifted lines
    // will get new IDs, so they won't collide
    state.headSha = headSha;
    if (options.rescan) {
      // Clear processed to re-evaluate everything
      state.processed = {};
    }
    writeState(state);
  }

  // Step 2: Acquire lock
  if (!acquireLock(state)) {
    console.warn('[bugbot] Another bugbot run is in progress. Exiting.');
    process.exit(0);
  }

  try {
    // Step 3: Fetch bugbot comments
    console.log('[bugbot] Fetching bugbot comments...');
    const allComments = fetchBugbotComments(prNumber);
    if (allComments.length === 0) {
      console.log('[bugbot] No bugbot comments found. Nothing to do.');
      releaseLock(state);
      process.exit(0);
    }
    console.log(`[bugbot] Found ${allComments.length} bugbot comment(s)`);

    // Step 4: Check for human dismissals on previously ai-dismissed items
    for (const [commentId, entry] of Object.entries(state.processed)) {
      if (entry.status === 'ai-dismissed') {
        if (checkForHumanDismissal(prNumber, parseInt(commentId, 10))) {
          entry.status = 'human-dismissed';
          writeState(state);
          if (options.verbose) {
            console.log(`[bugbot] Comment #${commentId} human-dismissed`);
          }
        }
      }
    }

    // Step 5: Filter to unprocessed comments
    const unprocessed = allComments.filter(c => !isProcessed(state, c.id));
    if (unprocessed.length === 0) {
      console.log('[bugbot] All comments already processed.');
      // Still check merge gate
      const gate = checkMergeGate(state);
      if (!gate.canMerge) {
        console.log(`[bugbot] Merge blocked -- ${gate.blocking.length} unresolved HIGH finding(s):`);
        gate.blocking.forEach(b => console.log(`  - ${b}`));
      } else {
        console.log('[bugbot] Merge gate: PASS');
      }
      releaseLock(state);
      process.exit(0);
    }

    console.log(`[bugbot] ${unprocessed.length} unprocessed comment(s) to triage`);

    // Step 6: Triage
    console.log('[bugbot] Triaging findings...');
    const triageResults = triageAll(unprocessed, options.verbose);

    // Step 7: Execute actions (unless dry run)
    let fixResults: FixResult[] = [];

    if (!options.dryRun) {
      // Apply auto-fixes
      const fixableCount = triageResults.filter(t => t.action === 'auto_fix').length;
      if (fixableCount > 0) {
        console.log(`[bugbot] Applying ${fixableCount} auto-fix(es)...`);
        fixResults = applyFixes(unprocessed, triageResults, options.verbose);
      }

      // Post reply comments
      console.log('[bugbot] Posting triage replies...');
      for (const triage of triageResults) {
        const comment = unprocessed.find(c => c.id === triage.commentId);
        if (comment) {
          postTriageReply(prNumber, comment, triage);
        }
      }
    } else {
      console.log('[bugbot] Dry run -- skipping fixes and comments');
    }

    // Step 8: Update state
    for (const triage of triageResults) {
      const fix = fixResults.find(f => f.commentId === triage.commentId);

      let status: ProcessedStatus;
      if (triage.action === 'auto_fix' && fix?.success) {
        status = 'fixed';
      } else if (triage.action === 'auto_fix' && fix && !fix.success) {
        status = 'needs-human';
      } else if (triage.action === 'dismiss' && triage.verdict === 'false_positive') {
        // HIGH false positives stay as ai-dismissed (merge gate blocks until human confirms)
        status = 'ai-dismissed';
      } else if (triage.action === 'dismiss' && triage.verdict === 'low_value') {
        // Low-value findings are skipped — don't block the merge gate
        status = 'skipped';
      } else if (triage.action === 'propose_patch') {
        status = 'proposed';
      } else if (triage.action === 'ask_question') {
        status = 'asked';
      } else if (triage.action === 'needs_human') {
        status = 'needs-human';
      } else {
        status = 'ai-dismissed';
      }

      if (!options.dryRun) {
        markProcessed(state, triage.commentId, {
          status,
          reason: triage.reason,
          commitSha: fix?.commitSha,
          triageResult: triage,
        });
      }
    }

    // Step 9: Summary
    const rows = buildSummaryRows(unprocessed, triageResults, fixResults);
    printConsoleSummary(rows);

    if (!options.dryRun) {
      // Push if fixes were committed
      const fixedCount = fixResults.filter(f => f.success).length;
      if (fixedCount > 0) {
        console.log('[bugbot] Pushing fixes...');
        const pushResult = runSafe('git', ['push'], { timeout: 30000 });
        if (!pushResult) {
          console.warn('[bugbot] Push failed -- fixes are committed locally but not pushed');
        }
      }

      // Post summary comment on PR
      const summary = formatGitHubSummary(rows);
      postSummaryComment(prNumber, summary);
    }

    // Step 10: Merge gate check
    const gate = checkMergeGate(state);
    if (!gate.canMerge) {
      console.log(`\n[bugbot] Merge blocked -- ${gate.blocking.length} unresolved HIGH finding(s):`);
      gate.blocking.forEach(b => console.log(`  - ${b}`));
    } else {
      console.log('\n[bugbot] Merge gate: PASS');
    }
  } finally {
    releaseLock(state);
  }
}

main().catch(err => {
  console.error('[bugbot] Fatal:', err);
  // Try to release lock on error
  try {
    const state = readState();
    if (state) releaseLock(state);
  } catch {}
  process.exit(1);
});
