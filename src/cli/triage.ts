import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import {
  loadTriage, saveTriage, addTriageEntry, removeTriageEntry, clearExpiredEntries,
  type TriageState,
} from '../core/persist/triage.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface TriageCommandOptions {
  cwd?: string;
}

function parseTriageArgs(rest: string[]): { reason?: string; expiresInDays?: number; positional: string[] } {
  let reason: string | undefined;
  let expiresInDays: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--reason' && rest[i + 1]) { reason = rest[++i]; }
    else if (rest[i] === '--expires' && rest[i + 1]) { expiresInDays = parseInt(rest[++i]!, 10); }
    else if (!rest[i]!.startsWith('--')) { positional.push(rest[i]!); }
  }
  return { reason, expiresInDays, positional };
}

export async function runTriage(
  subcommand: string | undefined,
  rest: string[],
  options: TriageCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  if (subcommand === 'list' || subcommand === 'show') {
    return cmdList(cwd);
  }

  if (subcommand === 'clear') {
    const { positional } = parseTriageArgs(rest);
    return cmdClear(cwd, positional, rest.includes('--expired'));
  }

  // Default: triage <finding-id> <state>
  const findingId = subcommand;
  const { reason, expiresInDays, positional } = parseTriageArgs(rest);
  const stateArg = positional[0];

  if (!findingId || !stateArg) {
    printUsage();
    return 1;
  }

  if (stateArg !== 'accepted-risk' && stateArg !== 'false-positive') {
    console.error(fmt('red', `[triage] State must be "accepted-risk" or "false-positive", got: "${stateArg}"`));
    return 1;
  }

  const findings = loadCachedFindings(cwd);
  const finding = findings.find(f => f.id === findingId || f.id.startsWith(findingId));
  if (!finding) {
    console.error(fmt('red', `[triage] Finding not found: "${findingId}"`));
    console.error(fmt('dim', '         Run `guardrail run` or `guardrail scan` first, then `guardrail report` to list IDs'));
    return 1;
  }

  addTriageEntry(cwd, finding, stateArg as TriageState, { reason, expiresInDays });

  const expNote = expiresInDays !== undefined ? fmt('dim', ` (expires in ${expiresInDays} days)`) : '';
  console.log(`${fmt('green', '✓')}  ${fmt('bold', stateArg)}  ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.message}${expNote}`);
  if (reason) console.log(fmt('dim', `   Reason: ${reason}`));
  console.log(fmt('dim', '   Suppressed from future runs. Commit .guardrail-triage.json to share with team.'));
  return 0;
}

function cmdList(cwd: string): number {
  const store = loadTriage(cwd);
  const now = new Date().toISOString();
  const active = store.entries.filter(e => !e.expiresAt || e.expiresAt > now);
  const expired = store.entries.filter(e => e.expiresAt && e.expiresAt <= now);

  if (store.entries.length === 0) {
    console.log(fmt('dim', '[triage] No triaged findings.'));
    return 0;
  }

  console.log(`\n${fmt('bold', '[guardrail triage]')} ${active.length} active, ${expired.length} expired\n`);
  for (const e of active) {
    const tag = e.state === 'false-positive'
      ? fmt('dim', 'false-positive ')
      : fmt('yellow', 'accepted-risk  ');
    const exp = e.expiresAt ? fmt('dim', ` expires ${e.expiresAt.slice(0, 10)}`) : '';
    console.log(`  [${tag}]  ${fmt('dim', `${e.file}${e.line ? `:${e.line}` : ''}`)} — ${e.id}${exp}`);
    if (e.reason) console.log(fmt('dim', `             Reason: ${e.reason}`));
  }
  if (expired.length > 0) {
    console.log(fmt('dim', `\n  ${expired.length} expired — run \`guardrail triage clear --expired\` to remove`));
  }
  console.log('');
  return 0;
}

function cmdClear(cwd: string, ids: string[], expired: boolean): number {
  if (expired) {
    const removed = clearExpiredEntries(cwd);
    console.log(fmt('dim', `[triage] Cleared ${removed} expired entr${removed === 1 ? 'y' : 'ies'}`));
    return 0;
  }
  if (ids.length === 0) {
    console.error(fmt('red', '[triage] clear requires a finding ID or --expired'));
    return 1;
  }
  const removed = removeTriageEntry(cwd, ids);
  console.log(fmt('dim', `[triage] Cleared ${removed} entr${removed === 1 ? 'y' : 'ies'}`));
  return 0;
}

function printUsage(): void {
  console.error(`
${fmt('bold', 'Usage:')}
  guardrail triage <finding-id> accepted-risk|false-positive [options]
  guardrail triage list
  guardrail triage clear <finding-id> [<id>...]
  guardrail triage clear --expired

${fmt('bold', 'Options:')}
  --reason <text>    Explain why this finding was triaged
  --expires <days>   Auto-expire triage after N days

${fmt('bold', 'States:')}
  accepted-risk      Known issue, risk accepted — suppress without fixing
  false-positive     Finding is incorrect — suppress permanently (or with expiry)

${fmt('dim', 'Finding IDs come from `guardrail report` or the run output.')}
`);
}
