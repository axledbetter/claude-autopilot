import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCachedFindings } from '../core/persist/findings-cache.ts';
import type { Finding } from '../core/findings/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

export interface ReportCommandOptions {
  cwd?: string;
  output?: string;  // file path to write markdown (default: stdout)
  format?: 'markdown' | 'text';
}

function severityOrder(s: Finding['severity']): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

function buildMarkdown(findings: Finding[], cwd: string): string {
  const critical = findings.filter(f => f.severity === 'critical');
  const warnings  = findings.filter(f => f.severity === 'warning');
  const notes     = findings.filter(f => f.severity === 'note');

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
    `| ⚠️ Warning  | ${warnings.length} |`,
    `| ℹ️ Note     | ${notes.length} |`,
    `| **Total**   | **${findings.length}** |`,
    '',
  ];

  function renderGroup(label: string, icon: string, group: Finding[]) {
    if (group.length === 0) return;
    lines.push(`## ${icon} ${label}`, '');
    for (const f of group) {
      const loc = f.file && f.file !== '<unspecified>' && f.file !== '<pipeline>'
        ? `\`${path.relative(cwd, path.resolve(cwd, f.file))}${f.line ? `:${f.line}` : ''}\``
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
  const md = buildMarkdown(sorted, cwd);

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
