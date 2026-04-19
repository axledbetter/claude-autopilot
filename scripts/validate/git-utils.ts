import * as fs from 'fs';
import { run, runSafe } from './exec-utils';

export function resolveMergeBase(baseBranch = 'origin/main'): string {
  const result = runSafe('git', ['merge-base', 'HEAD', baseBranch]);
  if (result) return result.trim();

  console.warn(`[validate] Could not resolve merge-base with ${baseBranch}, trying origin/master`);
  const fallback = runSafe('git', ['merge-base', 'HEAD', 'origin/master']);
  if (fallback) return fallback.trim();

  console.warn('[validate] Could not resolve merge-base with origin/master, using HEAD~20');
  return run('git', ['rev-parse', 'HEAD~20']).trim();
}

export function getTouchedFiles(mergeBase: string): string[] {
  const output = run('git', ['diff', '--name-only', `${mergeBase}...HEAD`]);
  return output.trim().split('\n').filter(Boolean);
}

export function isWorkingTreeClean(): boolean {
  const status = run('git', ['status', '--porcelain']).trim();
  return status.length === 0;
}

export function getCurrentBranch(): string {
  return run('git', ['branch', '--show-current']).trim();
}

export function storeFileBackup(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

export function restoreFileBackup(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function stageFiles(files: string[]): void {
  if (files.length === 0) return;
  run('git', ['add', ...files]);
}

export function commitChanges(message: string): string {
  run('git', ['commit', '-m', message]);
  return run('git', ['rev-parse', 'HEAD']).trim();
}
