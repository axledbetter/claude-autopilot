// `claude-autopilot dashboard status` — read config + call /me + print.

import {
  readConfig,
  warnIfPermissive,
  getConfigPath,
} from '../../dashboard/config.ts';

export interface StatusOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  silent?: boolean;
}

export interface MeResponse {
  email: string | null;
  fingerprint: string | null;
  organizations: Array<{ id: string; name: string; role: string }>;
  lastUploadAt: string | null;
}

export interface StatusResult {
  loggedIn: boolean;
  fingerprint: string | null;
  email: string | null;
  serverOk: boolean;
  organizations: Array<{ id: string; name: string; role: string }>;
  lastUploadAt: string | null;
  permissiveWarning: string | null;
}

export async function runDashboardStatus(opts: StatusOptions = {}): Promise<StatusResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? process.env.AUTOPILOT_DASHBOARD_BASE_URL ?? 'https://autopilot.dev';
  const cfg = await readConfig();
  const permissive = await warnIfPermissive();

  if (!cfg) {
    if (!opts.silent) {
      process.stdout.write(`[autopilot] not logged in. Run: claude-autopilot dashboard login\n`);
      process.stdout.write(`            (config path: ${getConfigPath()})\n`);
    }
    return {
      loggedIn: false,
      fingerprint: null,
      email: null,
      serverOk: false,
      organizations: [],
      lastUploadAt: null,
      permissiveWarning: permissive,
    };
  }

  let me: MeResponse | null = null;
  let serverOk = false;
  try {
    const res = await fetchImpl(`${baseUrl}/api/dashboard/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    if (res.ok) {
      me = await res.json() as MeResponse;
      serverOk = true;
    }
  } catch {
    /* network error — fall through with serverOk=false */
  }

  if (!opts.silent) {
    process.stdout.write(`[autopilot] logged in as ${cfg.accountEmail} (${cfg.fingerprint}).\n`);
    if (serverOk && me) {
      if (me.organizations.length > 0) {
        process.stdout.write(`            organizations: ${me.organizations.map((o) => `${o.name} (${o.role})`).join(', ')}\n`);
      }
      if (me.lastUploadAt) {
        process.stdout.write(`            last upload: ${me.lastUploadAt}\n`);
      }
    } else {
      process.stdout.write(`            (server unreachable; using cached config)\n`);
    }
    if (permissive) {
      process.stderr.write(`${permissive}\n`);
    }
  }

  return {
    loggedIn: true,
    fingerprint: cfg.fingerprint,
    email: cfg.accountEmail,
    serverOk,
    organizations: me?.organizations ?? [],
    lastUploadAt: me?.lastUploadAt ?? null,
    permissiveWarning: permissive,
  };
}
