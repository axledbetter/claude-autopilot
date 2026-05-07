// Snapshot-before-upload — copy events.ndjson + state.json to
// <runDir>/.upload-snapshot/ atomically before chunking begins.
// The uploader then reads only the snapshot, so the writer streaming new
// events into events.ndjson can't shift bytes mid-upload.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface SnapshotPaths {
  snapshotDir: string;
  events: string;
  state: string;
}

export interface SnapshotResult extends SnapshotPaths {
  /** Bytes of the snapshot events file. May be 0. */
  eventsBytes: number;
}

export class SnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotMismatchError';
  }
}

/**
 * Copy events.ndjson + state.json from `runDir` to `runDir/.upload-snapshot/`.
 *
 * Defense in depth: stat-before/stat-after on the source files, fail
 * loudly if size or mtime changes during copy. Per spec, snapshot is
 * post-`run.complete` only (writers are flushed) so this should never
 * fire — but if it does, abort rather than upload a torn read.
 */
export async function snapshotRun(runDir: string): Promise<SnapshotResult> {
  const eventsSrc = path.join(runDir, 'events.ndjson');
  const stateSrc = path.join(runDir, 'state.json');
  const snapshotDir = path.join(runDir, '.upload-snapshot');
  const eventsDst = path.join(snapshotDir, 'events.ndjson');
  const stateDst = path.join(snapshotDir, 'state.json');

  const eventsBefore = await fs.stat(eventsSrc);
  let stateBefore: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stateBefore = await fs.stat(stateSrc);
  } catch {
    // state.json may not exist for an in-flight run; we still snapshot events.
  }

  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.copyFile(eventsSrc, eventsDst);
  if (stateBefore) {
    await fs.copyFile(stateSrc, stateDst);
  }

  const eventsAfter = await fs.stat(eventsSrc);
  if (eventsAfter.size !== eventsBefore.size || eventsAfter.mtimeMs !== eventsBefore.mtimeMs) {
    throw new SnapshotMismatchError(
      `events.ndjson changed during snapshot (size ${eventsBefore.size}->${eventsAfter.size}, mtime ${eventsBefore.mtimeMs}->${eventsAfter.mtimeMs})`,
    );
  }
  if (stateBefore) {
    const stateAfter = await fs.stat(stateSrc);
    if (stateAfter.size !== stateBefore.size || stateAfter.mtimeMs !== stateBefore.mtimeMs) {
      throw new SnapshotMismatchError(
        `state.json changed during snapshot (size ${stateBefore.size}->${stateAfter.size})`,
      );
    }
  }

  return {
    snapshotDir,
    events: eventsDst,
    state: stateDst,
    eventsBytes: eventsAfter.size,
  };
}

export async function deleteSnapshot(runDir: string): Promise<void> {
  const snapshotDir = path.join(runDir, '.upload-snapshot');
  try {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  } catch {
    /* idempotent */
  }
}
