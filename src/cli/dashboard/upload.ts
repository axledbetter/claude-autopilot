// `claude-autopilot dashboard upload <runId>` — manual upload wrapper.
//
// Locates run dir at <homeDir>/runs/<runId>, calls uploadRun() directly,
// and prints the result. Intended for resuming interrupted auto-uploads.
//
// v7.8.0: probes `@supabase/supabase-js` availability before any upload work.
// Supabase is now an optionalDependency (so `npm install --omit=optional`
// works for local-only users); if a user invokes a dashboard verb without
// it installed, we surface an actionable install hint instead of a raw
// `ERR_MODULE_NOT_FOUND`. Wired through `loadSupabaseOrInstallHint` so the
// transitive-dep miss case is correctly distinguished (see
// missing-package.ts).

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { readConfig, getConfigDir } from '../../dashboard/config.ts';
import { uploadRun, type UploadOptions, type UploadResult } from '../../dashboard/upload/uploader.ts';
import { loadSupabaseOrInstallHint } from './missing-package.ts';

export interface ManualUploadOptions {
  runId: string;
  runsDir?: string;     // override default `<configDir>/runs`
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  silent?: boolean;
  signal?: AbortSignal;
}

export interface ManualUploadResult extends UploadResult {
  notLoggedIn?: boolean;
  runDirMissing?: boolean;
  runDir?: string;
}

export async function runDashboardUpload(opts: ManualUploadOptions): Promise<ManualUploadResult> {
  // v7.8.0 — supabase is an optionalDependency. Probe availability before
  // doing any upload work; if missing, surface the actionable install hint
  // (Error message defined in missing-package.ts). Local-only users who
  // installed with `npm install --omit=optional` will hit this on first
  // attempted upload and know exactly how to fix it.
  await loadSupabaseOrInstallHint();

  const cfg = await readConfig();
  if (!cfg) {
    if (!opts.silent) {
      process.stderr.write(`[autopilot] not logged in. Run: claude-autopilot dashboard login\n`);
    }
    return { ok: false, notLoggedIn: true };
  }

  const runsDir = opts.runsDir ?? path.join(getConfigDir(), 'runs');
  const runDir = path.join(runsDir, opts.runId);
  try {
    await fs.access(runDir);
  } catch {
    if (!opts.silent) {
      process.stderr.write(`[autopilot] run dir not found: ${runDir}\n`);
    }
    return { ok: false, runDirMissing: true, runDir };
  }

  const uploadOpts: UploadOptions = {
    apiKey: cfg.apiKey,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const res = await uploadRun(opts.runId, runDir, uploadOpts);

  if (!opts.silent) {
    if (res.ok && res.url) {
      process.stdout.write(`[autopilot] uploaded to ${res.url}\n`);
    } else if (res.ok && res.skipped) {
      process.stdout.write(`[autopilot] skipping upload — events.ndjson is empty\n`);
    } else {
      process.stderr.write(`[autopilot] upload failed: ${res.error}\n`);
    }
  }

  return { ...res, runDir };
}
