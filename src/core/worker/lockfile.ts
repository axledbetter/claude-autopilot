import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkerLock {
  pid: number;
  port: number;
  startedAt: string;
}

const LOCK_FILE = '.guardrail-cache/worker.lock';

export function lockfilePath(cwd: string): string {
  return path.join(cwd, LOCK_FILE);
}

export function readLock(cwd: string): WorkerLock | null {
  const p = lockfilePath(cwd);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as WorkerLock; }
  catch { return null; }
}

export function writeLock(cwd: string, lock: WorkerLock): void {
  const dir = path.join(cwd, '.guardrail-cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockfilePath(cwd), JSON.stringify(lock, null, 2), 'utf8');
}

export function deleteLock(cwd: string): void {
  const p = lockfilePath(cwd);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Returns true if the PID in the lock is currently alive. */
export function isWorkerAlive(lock: WorkerLock): boolean {
  try { process.kill(lock.pid, 0); return true; }
  catch { return false; }
}
