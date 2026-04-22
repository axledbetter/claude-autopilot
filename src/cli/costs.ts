import { readCostLog } from '../core/persist/cost-log.ts';
import type { CostLogEntry } from '../core/persist/cost-log.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return iso; }
}

function fmtUSD(n: number): string {
  return n === 0 ? fmt('dim', '$0.0000') : `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export async function runCosts(cwd = process.cwd()): Promise<number> {
  const log = readCostLog(cwd);

  if (log.length === 0) {
    console.log(fmt('yellow', '[costs] No run history found — run `guardrail run` first.'));
    return 0;
  }

  // 7-day window
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = log.filter(e => new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const last10 = log.slice(-10).reverse();

  const totalCost = log.reduce((s, e) => s + e.costUSD, 0);
  const totalInput = log.reduce((s, e) => s + e.inputTokens, 0);
  const totalOutput = log.reduce((s, e) => s + e.outputTokens, 0);
  const recentCost = recent.reduce((s, e) => s + e.costUSD, 0);

  console.log(`\n${fmt('bold', '[guardrail costs]')}\n`);

  // Summary row
  console.log(fmt('bold', 'Summary'));
  console.log(`  All-time runs:   ${log.length}`);
  console.log(`  All-time cost:   ${fmtUSD(totalCost)}  (${fmtTokens(totalInput)} in / ${fmtTokens(totalOutput)} out)`);
  console.log(`  Last 7 days:     ${fmtUSD(recentCost)}  (${recent.length} run${recent.length !== 1 ? 's' : ''})`);
  console.log('');

  // Last 10 runs table
  console.log(fmt('bold', `Recent runs (last ${last10.length})`));
  const COL = { date: 22, files: 7, input: 8, output: 8, cost: 10, dur: 8 };
  const header = [
    'Date'.padEnd(COL.date),
    'Files'.padStart(COL.files),
    'In tok'.padStart(COL.input),
    'Out tok'.padStart(COL.output),
    'Cost'.padStart(COL.cost),
    'Time'.padStart(COL.dur),
  ].join('  ');
  console.log(fmt('dim', '  ' + header));
  console.log(fmt('dim', '  ' + '─'.repeat(header.length)));

  for (const e of last10) {
    const row = [
      formatDate(e.timestamp).padEnd(COL.date),
      String(e.files).padStart(COL.files),
      fmtTokens(e.inputTokens).padStart(COL.input),
      fmtTokens(e.outputTokens).padStart(COL.output),
      fmtUSD(e.costUSD).padStart(COL.cost + 9), // +9 for ANSI codes in dim
      `${e.durationMs}ms`.padStart(COL.dur),
    ].join('  ');
    console.log('  ' + row);
  }

  console.log('');
  return 0;
}
