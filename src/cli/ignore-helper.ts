import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import type { Finding } from '../core/findings/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

const IGNORE_FILE = '.guardrail-ignore';

function readIgnoreFile(cwd: string): string {
  const p = path.join(cwd, IGNORE_FILE);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function appendIgnoreRule(cwd: string, rule: string): void {
  const p = path.join(cwd, IGNORE_FILE);
  const existing = readIgnoreFile(cwd);
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${separator}${rule}\n`, 'utf8');
}

function isAlreadyIgnored(existing: string, rule: string): boolean {
  return existing.split('\n').some(l => l.trim() === rule);
}

function buildRule(finding: Finding, scope: 'path' | 'rule+path' | 'rule'): string {
  if (scope === 'path') {
    const dir = path.dirname(finding.file);
    return dir === '.' ? finding.file : `${dir}/**`;
  }
  if (scope === 'rule') return `${finding.id} **`;
  // rule+path: most specific
  const dir = path.dirname(finding.file);
  const glob = dir === '.' ? finding.file : `${dir}/**`;
  return `${finding.id} ${glob}`;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export interface IgnoreCommandOptions {
  cwd?: string;
  all?: boolean;       // suppress all findings without prompting
  dryRun?: boolean;
}

export async function runIgnore(options: IgnoreCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const findings = loadCachedFindings(cwd);

  if (findings.length === 0) {
    console.log(fmt('yellow', '[ignore] No cached findings — run `guardrail run` or `guardrail scan` first.'));
    return 0;
  }

  const existing = readIgnoreFile(cwd);
  let added = 0;

  console.log(`\n${fmt('bold', '[ignore]')} ${findings.length} finding${findings.length !== 1 ? 's' : ''} to review\n`);

  for (const [i, f] of findings.entries()) {
    const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL')
              : f.severity === 'warning'  ? fmt('yellow', 'WARNING ')
              : fmt('dim',   'NOTE    ');
    const loc = f.file !== '<unspecified>' ? `${f.file}${f.line ? `:${f.line}` : ''}` : '<pipeline>';

    console.log(`\n${fmt('bold', `${i + 1}/${findings.length}`)}  [${sev}] ${f.message}`);
    console.log(fmt('dim', `     ${loc}  (rule: ${f.id})`));

    let scope: string;
    if (options.all) {
      scope = 'r';  // rule+path
    } else {
      console.log(fmt('dim', '     [s] skip  [p] suppress path  [r] suppress rule+path  [R] suppress rule everywhere  [q] quit'));
      scope = await prompt('     > ');
    }

    if (scope === 'q') break;
    if (scope === 's' || scope === '') continue;

    const ruleScope = scope === 'p' ? 'path' : scope === 'R' ? 'rule' : 'rule+path';
    const rule = buildRule(f, ruleScope);

    if (isAlreadyIgnored(existing, rule)) {
      console.log(fmt('dim', `     (already in ${IGNORE_FILE}: ${rule})`));
      continue;
    }

    if (options.dryRun) {
      console.log(fmt('dim', `     (dry run) would add: ${rule}`));
    } else {
      appendIgnoreRule(cwd, rule);
      console.log(fmt('green', `     + added: ${rule}`));
    }
    added++;
  }

  console.log('');
  if (options.dryRun) {
    console.log(fmt('yellow', `[ignore] Dry run — ${added} rule${added !== 1 ? 's' : ''} would be added to ${IGNORE_FILE}\n`));
  } else if (added > 0) {
    console.log(fmt('green', `[ignore] ${added} rule${added !== 1 ? 's' : ''} added to ${IGNORE_FILE}\n`));
  } else {
    console.log(fmt('dim', `[ignore] No rules added\n`));
  }
  return 0;
}
