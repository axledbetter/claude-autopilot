// Auto-upload at run.complete — non-fatal hosted-product hook.
//
// Contract (per spec): never fails the run. Always preserves the original
// exit code. Failure prints a resume command. Empty events.ndjson skips
// upload cleanly (Phase 2.2's POST /api/upload-session 422s expectedChunkCount=0).
//
// Opt-outs:
//   - explicit `--no-upload` flag → caller passes options.disabled=true
//   - env CLAUDE_AUTOPILOT_UPLOAD=off
//   - not logged in (no config)
//   - events.ndjson missing or 0 bytes

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { readConfig } from './config.ts';
import { uploadRun } from './upload/uploader.ts';

export interface AutoUploadOptions {
  /** Caller's explicit opt-out (e.g. CLI --no-upload). */
  disabled?: boolean;
  /** Test seam — substitute fetch impl. */
  fetchImpl?: typeof fetch;
  /** Test seam — silence stdout. */
  silent?: boolean;
}

export interface AutoUploadResult {
  attempted: boolean;
  ok: boolean;
  url: string | null;
  skipped: boolean;
  reason?: 'opt-out-flag' | 'env-off' | 'not-logged-in' | 'no-events' | 'aborted' | 'error';
}

export function shouldAutoUpload(options: AutoUploadOptions = {}): { ok: boolean; reason?: AutoUploadResult['reason'] } {
  if (options.disabled) return { ok: false, reason: 'opt-out-flag' };
  const env = process.env.CLAUDE_AUTOPILOT_UPLOAD;
  if (env && /^(off|false|0|no)$/i.test(env)) return { ok: false, reason: 'env-off' };
  return { ok: true };
}

async function fileExistsNonEmpty(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Run an auto-upload for the given runId. Wraps the foreground uploader
 * in a SIGINT/SIGTERM handler so Ctrl-C is clean. Always returns a result
 * — never throws. Caller preserves the run's original exit code.
 */
export async function autoUploadAtComplete(
  runId: string,
  runDir: string,
  options: AutoUploadOptions = {},
): Promise<AutoUploadResult> {
  const gate = shouldAutoUpload(options);
  if (!gate.ok) {
    return { attempted: false, ok: true, url: null, skipped: true, reason: gate.reason ?? 'opt-out-flag' };
  }

  const cfg = await readConfig();
  if (!cfg) {
    return { attempted: false, ok: true, url: null, skipped: true, reason: 'not-logged-in' };
  }

  const eventsPath = path.join(runDir, 'events.ndjson');
  const hasEvents = await fileExistsNonEmpty(eventsPath);
  if (!hasEvents) {
    return { attempted: false, ok: true, url: null, skipped: true, reason: 'no-events' };
  }

  const ac = new AbortController();
  const sigintHandler = (): void => ac.abort();
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigintHandler);

  try {
    const result = await uploadRun(runId, runDir, {
      apiKey: cfg.apiKey,
      signal: ac.signal,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (result.ok && result.url) {
      if (!options.silent) process.stdout.write(`[autopilot] uploaded to ${result.url}\n`);
      return { attempted: true, ok: true, url: result.url, skipped: false };
    }
    if (result.ok && result.skipped) {
      if (!options.silent) process.stdout.write(`[autopilot] skipping upload — events.ndjson is empty\n`);
      return { attempted: true, ok: true, url: null, skipped: true, reason: 'no-events' };
    }
    if (!options.silent) {
      process.stderr.write(`[autopilot] upload failed: ${result.error}\n`);
      process.stderr.write(`            Resume with: claude-autopilot dashboard upload ${runId}\n`);
    }
    return { attempted: true, ok: false, url: null, skipped: false, reason: 'error' };
  } catch (err) {
    if (ac.signal.aborted) {
      if (!options.silent) {
        process.stderr.write(`\n[autopilot] upload interrupted. Run is saved locally.\n`);
        process.stderr.write(`            Resume with: claude-autopilot dashboard upload ${runId}\n`);
      }
      return { attempted: true, ok: false, url: null, skipped: false, reason: 'aborted' };
    }
    if (!options.silent) {
      process.stderr.write(`[autopilot] upload error: ${(err as Error).message}\n`);
      process.stderr.write(`            Resume with: claude-autopilot dashboard upload ${runId}\n`);
    }
    return { attempted: true, ok: false, url: null, skipped: false, reason: 'error' };
  } finally {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigintHandler);
  }
}
