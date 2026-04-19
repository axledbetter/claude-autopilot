import { Finding, PhaseResult } from './types';
import { runSafe } from './exec-utils';

export async function runPhase6(prNumber?: number): Promise<PhaseResult> {
  const start = Date.now();
  const findings: Finding[] = [];

  if (prNumber) {
    const output = runSafe('gh', [
      'api', `repos/Delegance-Brokerage/delegance-app/pulls/${prNumber}/comments`,
      '--jq', '.[] | select(.user.type == "Bot" or .user.login == "cursor[bot]") | @json',
    ], { timeout: 30000 });

    if (output) {
      for (const line of output.trim().split('\n').filter(Boolean)) {
        try {
          const comment = JSON.parse(line);
          const firstLine = (comment.body || '').split('\n')[0].slice(0, 200);
          const severity = firstLine.toLowerCase().includes('high') ? 'critical' as const :
                          firstLine.toLowerCase().includes('medium') ? 'warning' as const : 'note' as const;
          findings.push({
            id: `bugbot-${comment.path || 'unknown'}-${comment.line || 0}`,
            phase: 'bugbot',
            severity,
            category: 'bugbot',
            file: comment.path || 'unknown',
            line: comment.line,
            message: firstLine,
            status: 'open',
            fixAttempted: false,
            protectedPath: false,
          });
        } catch { /* skip malformed */ }
      }
    }
  }

  const blocking = findings.filter(f => f.severity === 'critical').length;
  return { phase: 'gate', status: blocking > 0 ? 'fail' : 'pass', findings, durationMs: Date.now() - start };
}
