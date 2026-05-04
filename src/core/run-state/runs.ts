// src/core/run-state/runs.ts
//
// Top-level Run State Engine helpers — createRun, listRuns, gcRuns. These
// are the entry points the (yet-to-be-built) phase wrapper, CLI, and budget
// enforcer will call. Phase 1 ships only the data layer; later phases build
// on top.
//
// Spec: docs/specs/v6-run-state-engine.md "State on disk", "Run lifecycle",
// "Resume command".

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid, decodeTime } from './ulid.ts';
import { acquireRunLock, type RunLockHandle } from './lock.ts';
import { appendEvent, foldEvents, readEvents, stateToIndexEntry } from './events.ts';
import { writeStateSnapshot } from './state.ts';
import {
  RUN_STATE_SCHEMA_VERSION,
  type RunIndex,
  type RunIndexEntry,
  type RunState,
} from './types.ts';

const CACHE_DIR = '.guardrail-cache';
const RUNS_DIR = 'runs';
const INDEX_FILE = 'index.json';

export function runsRoot(cwd: string): string {
  return path.join(cwd, CACHE_DIR, RUNS_DIR);
}

export function indexPath(cwd: string): string {
  return path.join(runsRoot(cwd), INDEX_FILE);
}

export function runDirFor(cwd: string, runId: string): string {
  return path.join(runsRoot(cwd), runId);
}

export interface CreateRunOptions {
  cwd: string;
  /** Phase names in the order they will execute. */
  phases: string[];
  /** Snapshot of the relevant guardrail.config.yaml fields. Free-form. */
  config?: Record<string, unknown>;
}

export interface CreateRunResult {
  runId: string;
  runDir: string;
  state: RunState;
  /** Lock handle. Caller MUST `release()` on shutdown. */
  lock: RunLockHandle;
}

/** Create a fresh run directory, acquire its advisory lock, write the
 *  initial state.json, and emit the `run.start` event.
 *
 *  Throws GuardrailError(lock_held) if a stale lock exists for the freshly-
 *  generated runId — extremely unlikely (ULIDs are unique) but possible if
 *  two parallel invocations on the same OS clock collide on a leftover dir
 *  on disk. Caller can simply retry. */
export async function createRun(
  opts: CreateRunOptions,
): Promise<CreateRunResult> {
  if (!Array.isArray(opts.phases) || opts.phases.length === 0) {
    throw new Error('createRun: phases[] must be a non-empty array');
  }
  const runId = ulid();
  const runDir = runDirFor(opts.cwd, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Acquire BEFORE first event write so writerId is well-defined.
  const lock = await acquireRunLock(runDir);

  // Seed the state snapshot first (with no events yet) so that even a crash
  // before run.start lands leaves a recoverable artifact.
  const startedAt = new Date(decodeTime(runId)).toISOString();
  const initialState: RunState = {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    runId,
    startedAt,
    status: 'pending',
    phases: opts.phases.map((name, idx) => ({
      schema_version: RUN_STATE_SCHEMA_VERSION,
      name,
      index: idx,
      status: 'pending',
      idempotent: false,
      hasSideEffects: false,
      costUSD: 0,
      attempts: 0,
      artifacts: [],
      externalRefs: [],
    })),
    currentPhaseIdx: 0,
    totalCostUSD: 0,
    lastEventSeq: 0,
    writerId: lock.writerId,
    cwd: opts.cwd,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  };
  writeStateSnapshot(runDir, initialState);

  // Emit run.start. The appender owns the seq counter.
  const startEvent = appendEvent(
    runDir,
    {
      event: 'run.start',
      phases: opts.phases,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
    },
    { writerId: lock.writerId, runId },
  );

  // Refresh the snapshot to reflect lastEventSeq=1.
  initialState.lastEventSeq = startEvent.seq;
  writeStateSnapshot(runDir, initialState);

  // Refresh the index (best-effort — index is a pure cache).
  try {
    rebuildIndex(opts.cwd);
  } catch {
    // Index failure shouldn't block the run.
  }

  return { runId, runDir, state: initialState, lock };
}

// ----------------------------------------------------------------------------
// Listing + indexing.
// ----------------------------------------------------------------------------

function readIndex(cwd: string): RunIndex | null {
  const p = indexPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RunIndex;
  } catch {
    return null; // treat unreadable index as missing — it's a cache
  }
}

function writeIndex(cwd: string, index: RunIndex): void {
  fs.mkdirSync(runsRoot(cwd), { recursive: true });
  fs.writeFileSync(indexPath(cwd), JSON.stringify(index, null, 2), 'utf8');
}

/** Rebuild index.json from each run dir's state.json (or replayed state if
 *  the snapshot is missing / corrupt). Newest-first ordering by ULID. */
export function rebuildIndex(cwd: string): RunIndex {
  const root = runsRoot(cwd);
  const entries: RunIndexEntry[] = [];
  if (!fs.existsSync(root)) {
    const empty: RunIndex = { schema_version: RUN_STATE_SCHEMA_VERSION, runs: [] };
    writeIndex(cwd, empty);
    return empty;
  }
  const dirents = fs.readdirSync(root, { withFileTypes: true });
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const runId = d.name;
    const runDir = path.join(root, runId);
    let state: RunState;
    let recovered = false;
    try {
      // We don't hold the lock during a list — listing is read-only and
      // races with a concurrent writer are tolerated (we may briefly read
      // a stale snapshot, which is fine). For replay-recovery we DO need
      // a writerId, but only if the snapshot is bad; if so the run isn't
      // healthy anyway, and we use a synthetic writerId so we never
      // mutate the run's events.ndjson during a list operation.
      // Instead of recoverState (which writes events) we just replay
      // in-memory.
      const fromEvents = readEvents(runDir);
      // Build a fresh snapshot if state.json is missing or unreadable.
      // Use the project-internal file paths to avoid pulling readState
      // here just to throw.
      const stateFilePath = path.join(runDir, 'state.json');
      if (fs.existsSync(stateFilePath)) {
        try {
          state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as RunState;
        } catch {
          // fall through to replay
          recovered = true;
          // Replay needs the events; if the events are also corrupt we
          // surface the error via skip.
          state = replayInMemory(runDir, fromEvents.events);
        }
      } else {
        recovered = true;
        state = replayInMemory(runDir, fromEvents.events);
      }
    } catch {
      // Corrupt run dir — skip from the index entirely. `runs doctor`
      // (Phase 3) will surface these.
      continue;
    }
    entries.push(stateToIndexEntry(state, recovered));
  }
  // ULIDs are sortable; we want NEWEST first → reverse-sort by runId.
  entries.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  const index: RunIndex = { schema_version: RUN_STATE_SCHEMA_VERSION, runs: entries };
  writeIndex(cwd, index);
  return index;
}

/** In-memory replay used by rebuildIndex / listRuns — does NOT write to disk
 *  or emit events. Lets us pass pre-fetched events so we don't double-read
 *  the file. */
function replayInMemory(
  runDir: string,
  events: ReturnType<typeof readEvents>['events'],
): RunState {
  return foldEvents(runDir, events);
}

export interface ListRunsOptions {
  /** Force a rebuild from disk even if index.json is fresh. */
  rebuild?: boolean;
}

/** List all runs, newest-first. Lazily rebuilds index.json if missing. */
export function listRuns(cwd: string, opts: ListRunsOptions = {}): RunIndexEntry[] {
  if (opts.rebuild) return rebuildIndex(cwd).runs;
  const idx = readIndex(cwd);
  if (idx) return idx.runs;
  return rebuildIndex(cwd).runs;
}

// ----------------------------------------------------------------------------
// Garbage collection.
// ----------------------------------------------------------------------------

export interface GcRunsOptions {
  /** Delete completed runs older than this many days. Required. */
  olderThanDays: number;
  /** Don't actually delete; just return what would be removed. */
  dryRun?: boolean;
  /** Override "now" for tests. Default Date.now(). */
  now?: number;
}

export interface GcRunsResult {
  /** runIds that were (or would be) deleted. */
  deleted: string[];
  /** runIds skipped because they're still active or too young. */
  kept: string[];
  /** runIds skipped for safety reasons (symlink, suspicious path). */
  skippedUnsafe: string[];
}

/** Delete completed runs older than N days. Honors the spec's symlink
 *  safety: uses lstat so we never traverse a symlink out of the runs/
 *  tree. */
export function gcRuns(cwd: string, opts: GcRunsOptions): GcRunsResult {
  const root = runsRoot(cwd);
  const result: GcRunsResult = { deleted: [], kept: [], skippedUnsafe: [] };
  if (!fs.existsSync(root)) return result;
  const cutoff = (opts.now ?? Date.now()) - opts.olderThanDays * 86_400_000;

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const d of entries) {
    if (d.name === INDEX_FILE) continue;
    const runId = d.name;
    const runDir = path.join(root, runId);

    // Symlinks (whether to dirs or files) are flagged unsafe. Dirent's
    // isDirectory() returns FALSE for a symlink even if the target is a
    // directory, which matches our policy here — we only operate on real
    // dirs that lstat agrees are not links.
    if (d.isSymbolicLink()) {
      result.skippedUnsafe.push(runId);
      continue;
    }
    if (!d.isDirectory()) continue;

    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(runDir);
    } catch {
      result.skippedUnsafe.push(runId);
      continue;
    }
    if (!lst.isDirectory() || lst.isSymbolicLink()) {
      result.skippedUnsafe.push(runId);
      continue;
    }

    // Read state to decide. If unreadable, skip — `runs doctor` will deal.
    let state: RunState | null = null;
    try {
      const sp = path.join(runDir, 'state.json');
      if (fs.existsSync(sp)) {
        state = JSON.parse(fs.readFileSync(sp, 'utf8')) as RunState;
      }
    } catch {
      // fall through
    }

    if (!state) {
      // Defensive: try to derive from ULID alone for "old enough" check.
      // If runId isn't a ULID we treat it as suspicious and skip.
      let createdMs: number;
      try {
        createdMs = decodeTime(runId);
      } catch {
        result.skippedUnsafe.push(runId);
        continue;
      }
      if (createdMs >= cutoff) {
        result.kept.push(runId);
        continue;
      }
      // Fall through — eligible for delete.
    } else {
      const terminal = state.status === 'success' || state.status === 'failed' || state.status === 'aborted';
      if (!terminal) {
        result.kept.push(runId);
        continue;
      }
      const endMs = state.endedAt ? Date.parse(state.endedAt) : Date.parse(state.startedAt);
      if (Number.isFinite(endMs) && endMs >= cutoff) {
        result.kept.push(runId);
        continue;
      }
    }

    if (opts.dryRun) {
      result.deleted.push(runId);
      continue;
    }
    try {
      // Defense in depth: refuse to recurse out via a symlink hidden inside.
      // fs.rmSync with `force: true, recursive: true` handles dirs but
      // also follows nothing — it doesn't traverse symlinks for deletion
      // boundaries (it deletes the link, not the target).
      fs.rmSync(runDir, { recursive: true, force: true });
      result.deleted.push(runId);
    } catch {
      result.skippedUnsafe.push(runId);
    }
  }

  // Refresh the index after a real GC pass.
  if (!opts.dryRun && result.deleted.length > 0) {
    try { rebuildIndex(cwd); } catch { /* index is cache */ }
  }

  return result;
}
