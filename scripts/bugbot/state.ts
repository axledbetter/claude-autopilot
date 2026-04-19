/**
 * Persistent state for bugbot runs — tracks which comments have been processed
 * and the lock to prevent concurrent runs.
 *
 * State is stored in .claude/bugbot-state.json (gitignored).
 * Customize STATE_PATH if your project uses a different .claude location.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BugbotState, ProcessedEntry, TriageResult } from './types';

const STATE_PATH = path.join(process.cwd(), '.claude', 'bugbot-state.json');

export function readState(): BugbotState | null {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeState(state: BugbotState): void {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

export function createState(prNumber: number, headSha: string): BugbotState {
  const state: BugbotState = { prNumber, headSha, processed: {} };
  writeState(state);
  return state;
}

export function acquireLock(state: BugbotState): boolean {
  if (state.lockPid && state.lockPid !== process.pid) {
    // Check if the locking process is still running
    try {
      process.kill(state.lockPid, 0);
      return false; // still running
    } catch {
      // Process gone — take the lock
    }
  }
  state.lockPid = process.pid;
  writeState(state);
  return true;
}

export function releaseLock(state: BugbotState): void {
  delete state.lockPid;
  writeState(state);
}

export function isProcessed(state: BugbotState, commentId: number): boolean {
  return !!state.processed[String(commentId)];
}

export function markProcessed(
  state: BugbotState,
  commentId: number,
  entry: { status: ProcessedEntry['status']; reason: string; commitSha?: string; triageResult?: TriageResult }
): void {
  state.processed[String(commentId)] = entry;
  writeState(state);
}
