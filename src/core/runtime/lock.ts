import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';

export interface LockHandle {
  release(): Promise<void>;
}

export function acquireLock(runId: string, lockDir = '.claude'): LockHandle {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, '.lock');
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ runId, pid: process.pid, acquiredAt: new Date().toISOString() }),
      { flag: 'wx' }
    );
  } catch (err) {
    throw new GuardrailError('Another autopilot run holds the lock', {
      code: 'concurrency_lock',
      details: { lockPath, cause: err instanceof Error ? err.message : String(err) },
    });
  }
  return {
    release: async () => {
      try { await fs.promises.unlink(lockPath); } catch { /* best effort */ }
    },
  };
}
