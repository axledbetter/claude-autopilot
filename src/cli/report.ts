import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import { readCostLog } from '../core/persist/cost-log.ts';
import type { Finding } from '../core/findings/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface ReportCommandOptions {
  cwd?: string;
  output?: string;   // file path to write markdown (default: stdout)
  trend?: boolean;   // include trend analysis from cost log run history
}

function severityOrder(s: Finding['severity']): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function buildTrendSection(cwd: string): string {
  const log = readCostLog(cwd);
  if (log.length === 0) return '';

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = log.filter(e => new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const totalCost = log.reduce((s, e) => s + e.costUSD, 0);
  const avgFiles = log.reduce((s, e) => s + e.files, 0) / log.length;

  const lines: string[] = [
    '## 📈 Trend',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Runs (7d) | ${recent.length} |`,
    `| Runs (all-time) | ${log.length} |`,
    `| All-time cost | $${totalCost.toFixed(4)} |`,
    `| Avg files/run | ${avgFiles.toFixed(1)} |`,
    '',
  ];

  if (recent.length > 0) {
    lines.push('### Recent runs', '');
    lines.push('| Date | Files | Cost |');
    lines.push('|------|-------|------|');
    for (const e of recent.slice(-7).reverse()) {
      const d = new Date(e.timestamp).toLocaleDateString();
      lines.push(`| ${d} | ${e.files} | $${e.costUSD.toFixed(4)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildFileBreakdown(findings: Finding[]): string {
  const withFiles = findings.filter(f => f.file && f.file !== '<unspecified>' && f.file !== '<pipeline>');
  if (withFiles.length === 0) return '';

  const counts = new Map<string, { critical: number; warning: number; note: number; total: number }>();
  for (const f of withFiles) {
    const entry = counts.get(f.file) ?? { critical: 0, warning: 0, note: 0, total: 0 };
    entry[f.severity]++;
    entry.total++;
    counts.set(f.file, entry);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  if (sorted.length < 2) return ''; // single file — not worth a table

  const lines = [
    '## 📁 By File',
    '',
    '| File | Critical | Warning | Note | Total |',
    '|------|----------|---------|------|-------|',
  ];
  for (const [file, c] of sorted) {
    lines.push(`| \`${file}\` | ${c.critical || '–'} | ${c.warning || '–'} | ${c.note || '–'} | **${c.total}** |`);
  }
  if (counts.size > 10) lines.push(`| *(${counts.size - 10} more files)* | | | | |`);
  lines.push('');
  return lines.join('\n');
}

function buildSourceBreakdown(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.source, (counts.get(f.source) ?? 0) + 1);
  }
  if (counts.size < 2) return '';

  const lines = ['## 🔬 By Source', '', '| Source | Findings |', '|--------|----------|'];
  for (const [source, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${source} | ${n} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildMarkdown(findings: Finding[], cwd: string, trend: boolean): string {
  const critical = findings.filter(f => f.severity === 'critical');
  const warnings  = findings.filter(f => f.severity === 'warning');
  const notes     = findings.filter(f => f.severity === 'note');
  const fixable   = critical.length + warnings.length;

  const lines: string[] = [
    '# Guardrail Report',
    '',
    `> Generated ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `| Severity | Count |`,
    `|----------|-------|`,
    `| 🚨 Critical | ${critical.length} |`,
    `| ⚠️  Warning  | ${warnings.length} |`,
    `| ℹ️  Note     | ${notes.length} |`,
    `| **Total**   | **${findings.length}** |`,
    '',
  ];

  if (fixable > 0) {
    lines.push(`> **${fixable} finding${fixable !== 1 ? 's' : ''} can be auto-fixed** — run \`guardrail fix\` to attempt repairs.`, '');
  }

  if (trend) {
    const trendSection = buildTrendSection(cwd);
    if (trendSection) lines.push(trendSection);
  }

  const fileBreakdown = buildFileBreakdown(findings);
  if (fileBreakdown) lines.push(fileBreakdown);

  const sourceBreakdown = buildSourceBreakdown(findings);
  if (sourceBreakdown) lines.push(sourceBreakdown);

  function renderGroup(label: string, icon: string, group: Finding[]) {
    if (group.length === 0) return;
    lines.push(`## ${icon} ${label}`, '');
    for (const f of group) {
      const loc = f.file && f.file !== '<unspecified>' && f.file !== '<pipeline>'
        ? `\`${f.file}${f.line ? `:${f.line}` : ''}\``
        : null;
      lines.push(`### ${loc ? `${loc} — ` : ''}${f.message}`);
      if (f.suggestion) lines.push('', `> **Suggestion:** ${f.suggestion}`);
      lines.push('', `*Source: ${f.source} · Rule: ${f.id}*`, '');
    }
  }

  renderGroup('Critical', '🚨', critical);
  renderGroup('Warnings', '⚠️', warnings);
  renderGroup('Notes', 'ℹ️', notes);

  if (findings.length === 0) {
    lines.push('## ✅ No findings', '', 'No cached findings — run `guardrail run` or `guardrail scan` first.', '');
  }

  return lines.join('\n');
}

export async function runReport(options: ReportCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const findings = loadCachedFindings(cwd);

  if (findings.length === 0) {
    console.log(fmt('yellow', '[report] No cached findings — run `guardrail run` or `guardrail scan` first.'));
    return 0;
  }

  const sorted = [...findings].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  const md = buildMarkdown(sorted, cwd, options.trend ?? false);

  if (options.output) {
    fs.writeFileSync(options.output, md, 'utf8');
    const critical = findings.filter(f => f.severity === 'critical').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    console.log(fmt('bold', `[report] Written to ${options.output}`));
    console.log(`  ${critical > 0 ? fmt('red', `${critical} critical`) : fmt('green', '0 critical')}  ${warnings > 0 ? fmt('yellow', `${warnings} warning${warnings !== 1 ? 's' : ''}`) : fmt('dim', '0 warnings')}`);
  } else {
    process.stdout.write(md + '\n');
  }

  return findings.some(f => f.severity === 'critical') ? 1 : 0;
}
