// `claude-autopilot dashboard <verb>` — umbrella dispatcher.
//
// Verbs: login | logout | status | upload <runId>

import { runDashboardLogin } from './login.ts';
import { runDashboardLogout } from './logout.ts';
import { runDashboardStatus } from './status.ts';
import { runDashboardUpload } from './upload.ts';

export interface DashboardArgs {
  argv: string[];
}

export async function runDashboardVerb(args: DashboardArgs): Promise<number> {
  const [verb, ...rest] = args.argv;
  switch (verb) {
    case 'login': {
      try {
        await runDashboardLogin();
        return 0;
      } catch (err) {
        process.stderr.write(`[autopilot] login failed: ${(err as Error).message}\n`);
        return 1;
      }
    }
    case 'logout': {
      await runDashboardLogout();
      return 0;
    }
    case 'status': {
      await runDashboardStatus();
      return 0;
    }
    case 'upload': {
      const runId = rest[0];
      if (!runId) {
        process.stderr.write(`[autopilot] usage: claude-autopilot dashboard upload <runId>\n`);
        return 2;
      }
      const result = await runDashboardUpload({ runId });
      if (result.ok) return 0;
      if (result.notLoggedIn || result.runDirMissing) return 2;
      return 1;
    }
    default: {
      process.stderr.write(`[autopilot] unknown dashboard verb: ${verb ?? '(none)'}\n`);
      process.stderr.write(`            valid verbs: login, logout, status, upload <runId>\n`);
      return 2;
    }
  }
}
