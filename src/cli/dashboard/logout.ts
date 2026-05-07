// `claude-autopilot dashboard logout` — revoke server-side, delete config locally.
//
// Idempotent: missing config or HTTP failure both still result in the
// local file being deleted. Server-side revocation is best-effort but we
// surface the status code on stdout for transparency.

import { readConfig, deleteConfig } from '../../dashboard/config.ts';

export interface LogoutOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  silent?: boolean;
}

export interface LogoutResult {
  hadConfig: boolean;
  serverRevoked: boolean;
  serverStatus: number | null;
}

export async function runDashboardLogout(opts: LogoutOptions = {}): Promise<LogoutResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.AUTOPILOT_DASHBOARD_BASE_URL ?? 'https://autopilot.dev';
  const cfg = await readConfig();
  if (!cfg) {
    if (!opts.silent) process.stdout.write(`[autopilot] not logged in.\n`);
    await deleteConfig();
    return { hadConfig: false, serverRevoked: false, serverStatus: null };
  }

  let status: number | null = null;
  let revoked = false;
  try {
    const res = await fetchImpl(`${baseUrl}/api/dashboard/api-keys/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: cfg.apiKey }),
    });
    status = res.status;
    revoked = res.ok;
  } catch {
    /* network error — local delete still proceeds */
  }

  await deleteConfig();
  if (!opts.silent) {
    if (revoked) {
      process.stdout.write(`[autopilot] logged out (key ${cfg.fingerprint} revoked).\n`);
    } else {
      process.stdout.write(`[autopilot] local config deleted; server revocation status=${status ?? 'network error'}.\n`);
    }
  }

  return { hadConfig: true, serverRevoked: revoked, serverStatus: status };
}
