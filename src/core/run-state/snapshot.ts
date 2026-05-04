// src/core/run-state/snapshot.ts
//
// Atomic per-phase snapshot writer/reader. Each phase, after run, gets a
// `phases/<name>.json` artifact mirroring the corresponding entry in
// state.json. Writes use the same tmp+rename+fsync protocol as state.json so
// a crash mid-write never leaves a half-baked phase snapshot on disk.
//
// Phase 1 left this as a TODO; Phase 2 fills it in to back the lifecycle
// wrapper (`runPhase`).
//
// Spec: docs/specs/v6-run-state-engine.md "State on disk" — `phases/<name>.json`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuardrailError } from '../errors.ts';
import { type PhaseSnapshot } from './types.ts';

const PHASES_DIR = 'phases';

export function phasesDir(runDir: string): string {
  return path.join(runDir, PHASES_DIR);
}

export function phaseSnapshotPath(runDir: string, phaseName: string): string {
  return path.join(phasesDir(runDir), `${sanitizePhaseFilename(phaseName)}.json`);
}

/** Reject filename characters that would escape `phases/`. Phase names are
 *  caller-supplied strings; we bound them to a safe charset rather than
 *  letting `..` / path separators sneak in.
 *
 *  Allowed: ASCII alphanumerics, dash, underscore, dot. Anything else is
 *  rejected with a typed error so callers can correct the call-site rather
 *  than silently producing a write to `../somewhere`. */
function sanitizePhaseFilename(phaseName: string): string {
  if (!phaseName || typeof phaseName !== 'string') {
    throw new GuardrailError(
      `phase snapshot: name must be a non-empty string`,
      { code: 'invalid_config', provider: 'run-state', details: { phaseName } },
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(phaseName)) {
    throw new GuardrailError(
      `phase snapshot: name "${phaseName}" contains unsupported characters`,
      { code: 'invalid_config', provider: 'run-state', details: { phaseName } },
    );
  }
  return phaseName;
}

/** Write a per-phase snapshot atomically. Identical sequence to
 *  state.json:
 *    open(tmp, 'w') → write → fsync(fd) → close → rename → fsync(dirfd).
 *
 *  Any pre-existing snapshot is left untouched until the rename, so a crash
 *  mid-write leaves the previous snapshot intact. */
export function writePhaseSnapshot(
  runDir: string,
  snapshot: PhaseSnapshot,
): void {
  const dir = phasesDir(runDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = phaseSnapshotPath(runDir, snapshot.name);
  const tmp = `${target}.tmp`;
  const data = JSON.stringify(snapshot, null, 2);

  const fd = fs.openSync(tmp, 'w');
  let wroteOk = false;
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    wroteOk = true;
  } finally {
    fs.closeSync(fd);
    if (!wroteOk) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  fs.renameSync(tmp, target);

  // Best-effort dir fsync for rename durability. Same EISDIR/EPERM/ENOTSUP
  // tolerance as state.ts (tmpfs / SMB / Windows quirks).
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP') {
      throw new GuardrailError(
        `phase snapshot: dir fsync failed: ${(err as Error).message}`,
        {
          code: 'corrupted_state',
          provider: 'run-state',
          details: { runDir, phaseName: snapshot.name, errno: code },
        },
      );
    }
  }
}

/** Read a per-phase snapshot. Returns null if missing. Throws
 *  GuardrailError(corrupted_state) if it's present-but-unparseable. */
export function readPhaseSnapshot(
  runDir: string,
  phaseName: string,
): PhaseSnapshot | null {
  const p = phaseSnapshotPath(runDir, phaseName);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw) {
    throw new GuardrailError(`phase snapshot: empty file ${p}`, {
      code: 'corrupted_state',
      provider: 'run-state',
      details: { runDir, phaseName },
    });
  }
  try {
    return JSON.parse(raw) as PhaseSnapshot;
  } catch (err) {
    throw new GuardrailError(
      `phase snapshot: corrupt JSON: ${(err as Error).message}`,
      {
        code: 'corrupted_state',
        provider: 'run-state',
        details: { runDir, phaseName, error: (err as Error).message },
      },
    );
  }
}
