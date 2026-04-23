import type { RunResult } from '../core/pipeline/run.ts';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function toJUnit(result: RunResult, opts: { suiteName?: string } = {}): string {
  const name = opts.suiteName ?? 'guardrail';
  const findings = result.allFindings;
  const failures = findings.filter(f => f.severity === 'critical').length;
  const total = findings.length;
  const time = (result.durationMs / 1000).toFixed(3);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(name)}" tests="${total}" failures="${failures}" time="${time}">`,
    `  <testsuite name="${escapeXml(name)}" tests="${total}" failures="${failures}" errors="0" time="${time}">`,
  ];

  if (findings.length === 0) {
    lines.push(`    <testcase name="no findings" classname="${escapeXml(name)}" />`);
  }

  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    const testName = escapeXml(`[${f.severity.toUpperCase()}] ${f.category} — ${loc}`);
    const classname = escapeXml(f.file.replace(/\//g, '.').replace(/\.[tj]sx?$/, ''));
    const body = escapeXml(f.message + (f.suggestion ? `\n${f.suggestion}` : ''));

    if (f.severity === 'critical') {
      lines.push(
        `    <testcase name="${testName}" classname="${classname}">`,
        `      <failure type="${escapeXml(f.category)}" message="${escapeXml(f.message)}">${body}</failure>`,
        `    </testcase>`,
      );
    } else {
      lines.push(
        `    <testcase name="${testName}" classname="${classname}">`,
        `      <system-out>${body}</system-out>`,
        `    </testcase>`,
      );
    }
  }

  lines.push('  </testsuite>', '</testsuites>');
  return lines.join('\n');
}
