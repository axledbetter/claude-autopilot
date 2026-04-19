#!/usr/bin/env tsx

import { parseArgs } from 'util';
import type { ValidateOptions, ValidationReport, PhaseResult } from './validate/types';
import { resolveMergeBase, getTouchedFiles, getCurrentBranch, isWorkingTreeClean } from './validate/git-utils';
import { runSafe } from './validate/exec-utils';
import { runPhase1 } from './validate/phase1-static';
import { runPhase2 } from './validate/phase2-autofix';
import { runPhase4 } from './validate/phase4-tests';
import { runPhase5 } from './validate/phase5-codex';
import { runPhase6 } from './validate/phase6-gate';
import { printReport, saveReport } from './validate/reporter';

// Parse CLI args
const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'pre-pr' },
    pr: { type: 'string' },
    force: { type: 'boolean', default: false },
    'skip-codex': { type: 'boolean', default: false },
    'skip-tests': { type: 'boolean', default: false },
    'commit-autofix': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    base: { type: 'string', default: 'origin/main' },
  },
});

const options: ValidateOptions = {
  mode: (values.mode as ValidateOptions['mode']) || 'pre-pr',
  prNumber: values.pr ? parseInt(values.pr, 10) : undefined,
  force: !!values.force,
  skipCodex: !!values['skip-codex'],
  skipTests: !!values['skip-tests'],
  commitAutofix: !!values['commit-autofix'],
  allowDirty: !!values['allow-dirty'],
  verbose: !!values.verbose,
  baseBranch: (values.base) || 'origin/main',
};

async function main() {
  if (!options.allowDirty && !isWorkingTreeClean()) {
    console.error('[validate] Working tree has uncommitted changes. Use --allow-dirty to proceed.');
    process.exit(1);
  }

  const branch = getCurrentBranch();
  const mergeBase = resolveMergeBase(options.baseBranch);
  const touchedFiles = getTouchedFiles(mergeBase);

  if (touchedFiles.length === 0) {
    console.log('[validate] No files changed. Nothing to validate.');
    process.exit(0);
  }

  console.log(`[validate] Branch: ${branch} | Base: ${mergeBase.slice(0, 8)} | Files: ${touchedFiles.length}`);

  const phases: PhaseResult[] = [];

  // Phase 1
  console.log('[validate] Phase 1: Static checks...');
  phases.push(await runPhase1(touchedFiles));

  // Phase 2
  // Capture dirty files before Phase 2 so we can detect only newly modified files
  const dirtyBefore = new Set(
    (runSafe('git', ['diff', '--name-only']) || '').trim().split('\n').filter(Boolean)
  );
  console.log('[validate] Phase 2: Mechanical auto-fix...');
  const phase2 = await runPhase2(touchedFiles);
  phases.push(phase2);

  // Phase 3: re-check only if Phase 2 itself introduced new modifications
  const dirtyAfter = (runSafe('git', ['diff', '--name-only']) || '').trim().split('\n').filter(Boolean);
  const newlyModified = dirtyAfter.filter(f => !dirtyBefore.has(f));
  if (newlyModified.length > 0) {
    console.log('[validate] Phase 3: Re-checking statics...');
    phases.push({ ...(await runPhase1(touchedFiles)), phase: 'static-recheck' });
  }

  // Phase 4
  if (!options.skipTests) {
    console.log('[validate] Phase 4: Running tests...');
    phases.push(await runPhase4());
  }

  // Phase 5
  if (!options.skipCodex) {
    console.log('[validate] Phase 5: Codex review + auto-fix...');
    const phase5 = await runPhase5(touchedFiles, { commitAutofix: options.commitAutofix, verbose: options.verbose });
    phases.push(phase5);

    if (phase5.findings.some(f => f.status === 'fixed') && !options.skipTests) {
      console.log('[validate] Phase 5b: Re-running tests after Codex fixes...');
      phases.push({ ...(await runPhase4()), phase: 'tests-post-codex' });
    }
  }

  // Phase 6
  console.log('[validate] Phase 6: Final gate...');
  phases.push(await runPhase6(options.prNumber));

  // Build report
  const allFindings = phases.flatMap(p => p.findings);
  const report: ValidationReport = {
    reportVersion: 1,
    timestamp: new Date().toISOString(),
    branch,
    mergeBase,
    mode: options.mode,
    verdict: 'PASS',
    phases,
    touchedFiles,
    summary: {
      totalChecks: allFindings.length,
      passed: allFindings.filter(f => f.severity === 'note').length,
      warnings: allFindings.filter(f => f.severity === 'warning' && f.status !== 'fixed').length,
      blocking: allFindings.filter(f => f.severity === 'critical' && f.status !== 'fixed').length,
      autoFixed: allFindings.filter(f => f.status === 'fixed').length,
      humanRequired: allFindings.filter(f => f.status === 'human_required').length,
    },
  };

  if (report.summary.blocking > 0) report.verdict = 'FAIL';

  printReport(report);
  saveReport(report);

  if (report.verdict === 'FAIL' && !options.force) process.exit(1);
}

main().catch(err => { console.error('[validate] Fatal:', err); process.exit(1); });
