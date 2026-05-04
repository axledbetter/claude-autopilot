// src/core/run-state/lock.ts
//
// Per-run advisory lock. Wraps `proper-lockfile` with a sidecar metadata file
// (`.lock-meta.json`) that records WHICH writer (pid + hostHash) owns the
// lock, so a second invocation can either fail-fast with a precise error or
// take over with `forceTakeover()`.
//
// proper-lockfile itself only stores `mtime`; it doesn't track owner identity,
// so we maintain it ourselves alongside the lock.
//
// Spec: docs/specs/v6-run-state-engine.md "Persistence protocol — Per-run
// advisory lock", "Single-writer invariant".

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import lockfile from 'proper-lockfile';
import { GuardrailError } from '../errors.ts';
import type { LockTakeoverEvent, RunEventInput, WriterId } from './types.ts';

/** File proper-lockfile guards. We pin a specific name so relocation /
 *  copy of the run dir doesn't accidentally inherit a stale lock from
 *  another path. */
const LOCK_TARGET = '.lock';
/** Sidecar JSON that records the current owner. Kept separate from the
 *  proper-lockfile-managed `.lock` directory so we never race the
 *  acquisition primitive. */
const LOCK_META = '.lock-meta.json';

/** Default stale timeout. After this many ms with no `update`, the lock is
 *  considered stale and another writer may acquire. Matches proper-lockfile
 *  default (10s). */
const DEFAULT_STALE_MS = 10_000;

interface LockMeta {
  writerId: WriterId;
  acquiredAt: string;
  /** Last seq the writer confirmed it had appended. Optional — useful for
   *  takeover paths that want to resume the seq counter without rescanning
   *  events.ndjson. */
  lastSeq?: number;
}

/** Hash the hostname so we never persist raw machine identity. */
export function makeWriterId(): WriterId {
  return {
    pid: process.pid,
    hostHash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16),
  };
}

function lockTargetPath(runDir: string): string {
  return path.join(runDir, LOCK_TARGET);
}

function metaPath(runDir: string): string {
  return path.join(runDir, LOCK_META);
}

function writeMeta(runDir: string, meta: LockMeta): void {
  fs.writeFileSync(metaPath(runDir), JSON.stringify(meta, null, 2), 'utf8');
}

function readMeta(runDir: string): LockMeta | null {
  const p = metaPath(runDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as LockMeta;
  } catch {
    return null;
  }
}

function deleteMeta(runDir: string): void {
  try { fs.unlinkSync(metaPath(runDir)); } catch { /* idempotent */ }
}

/** True iff a process with the given PID is alive on THIS host. We refuse
 *  to make a determination for off-host PIDs (different hostHash) and treat
 *  them as alive — better to bail with `lock_held` than to silently steal a
 *  lock owned by another machine sharing a network filesystem. */
export function isPidAlive(writerId: WriterId | null): boolean {
  if (!writerId) return false;
  const me = makeWriterId();
  if (writerId.hostHash !== me.hostHash) {
    // Different host. We can't probe — assume alive (safer default).
    return true;
  }
  if (writerId.pid <= 0) return false;
  if (writerId.pid === me.pid) return true;
  try {
    // POSIX trick: kill(pid, 0) checks existence without delivering a signal.
    process.kill(writerId.pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process → not alive. EPERM = exists but we can't
    // signal it → still alive. Anything else, default to alive.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

export interface AcquireRunLockOptions {
  /** Override proper-lockfile stale ms. Default 10_000. */
  stale?: number;
  /** Retry config, forwarded to proper-lockfile. Default: no retries (we
   *  want fail-fast on contention so the caller can surface an actionable
   *  error). Set to a number / OperationOptions for blocking acquires. */
  retries?: number;
  /** Override the writerId. Tests use this to simulate cross-process owners
   *  without forking. Production callers should let it default. */
  writerId?: WriterId;
}

export interface RunLockHandle {
  writerId: WriterId;
  /** Releases the lock. Idempotent. */
  release: () => Promise<void>;
}

/** Acquire the per-run advisory lock. Throws GuardrailError(lock_held) if
 *  another writer owns it. The caller is expected to hold the returned
 *  handle for the duration of the run and call `release()` on shutdown. */
export async function acquireRunLock(
  runDir: string,
  opts: AcquireRunLockOptions = {},
): Promise<RunLockHandle> {
  fs.mkdirSync(runDir, { recursive: true });
  const target = lockTargetPath(runDir);
  if (!fs.existsSync(target)) fs.writeFileSync(target, '');

  const writerId = opts.writerId ?? makeWriterId();
  const stale = opts.stale ?? DEFAULT_STALE_MS;

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, {
      stale,
      retries: opts.retries ?? 0,
    });
  } catch (err) {
    // Fail-closed with a typed error so callers can build a good message.
    const owner = readMeta(runDir);
    throw new GuardrailError(
      `run lock held: cannot acquire ${target}: ${(err as Error).message}`,
      {
        code: 'lock_held',
        provider: 'run-state',
        details: {
          runDir,
          owner: owner?.writerId ?? null,
          acquiredAt: owner?.acquiredAt ?? null,
        },
      },
    );
  }

  // Write our metadata. We do this AFTER acquisition so a partial-create
  // (if we crash here) leaves us as the orphaned owner rather than a phantom.
  writeMeta(runDir, { writerId, acquiredAt: new Date().toISOString() });

  let released = false;
  return {
    writerId,
    release: async () => {
      if (released) return;
      released = true;
      // Always try to clear meta even if release throws; the lockfile is
      // the authoritative gate, and a stale meta with no .lock around
      // would be merely cosmetic.
      try {
        await release();
      } finally {
        deleteMeta(runDir);
      }
    },
  };
}

/** Update the lastSeq field in the lock metadata. Best-effort; never throws.
 *  The events.ndjson is the source of truth, so a missed update is harmless. */
export function updateLockSeq(runDir: string, lastSeq: number): void {
  const meta = readMeta(runDir);
  if (!meta) return;
  try {
    writeMeta(runDir, { ...meta, lastSeq });
  } catch {
    // intentionally swallowed — observability sidecar
  }
}

/** Non-blocking peek at who currently owns the lock. Returns null if no
 *  metadata is present (which generally means no live writer either, but
 *  callers should not infer aliveness from that alone). */
export function peekLockOwner(runDir: string): LockMeta | null {
  return readMeta(runDir);
}

/** Forcibly take ownership. Returns the `lock.takeover` event the caller
 *  should append (the events log is sequenced by the appender, so this
 *  function deliberately does NOT write to events.ndjson itself).
 *
 *  Throws GuardrailError(lock_held) if the previous writer is still alive
 *  per `isPidAlive` — taking over a live writer would corrupt the log.
 *
 *  After this call returns, the caller should:
 *    1. Append the returned event via `appendEvent`.
 *    2. Call `acquireRunLock` to obtain the new handle.
 *    Both steps run after takeover. We do not auto-acquire here so the
 *    caller can decide on its own retry / stale-ms strategy.
 */
export function forceTakeover(
  runDir: string,
  reason: string,
): RunEventInput & { event: 'lock.takeover' } {
  const previous = readMeta(runDir);
  const previousWriter = previous?.writerId ?? null;

  if (isPidAlive(previousWriter)) {
    throw new GuardrailError(
      `run lock takeover refused: previous writer is still alive`,
      {
        code: 'lock_held',
        provider: 'run-state',
        details: { runDir, previousWriter, reason },
      },
    );
  }

  // Wipe the proper-lockfile state too so the next acquire doesn't trip
  // over a stale entry. lockfile.lock creates a directory at `${file}.lock`;
  // we remove it so the subsequent acquire path is clean.
  try {
    fs.rmSync(lockTargetPath(runDir) + '.lock', { recursive: true, force: true });
  } catch {
    // ignore — proper-lockfile will recreate on next acquire
  }
  deleteMeta(runDir);

  // Caller appends this with `appendEvent`. Returning the input shape (no
  // seq/ts/runId/schema_version/writerId yet) — the appender fills them in.
  return {
    event: 'lock.takeover',
    previousWriter,
    reason,
  };
}
