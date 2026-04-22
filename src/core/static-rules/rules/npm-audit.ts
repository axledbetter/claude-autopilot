import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSafe } from '../../shell.ts';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

export const npmAuditRule: StaticRule = {
  name: 'npm-audit',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const cwd = process.cwd();
    if (!fs.existsSync(path.join(cwd, 'package.json'))) return [];

    const out = runSafe('npm', ['audit', '--json'], { cwd });
    if (!out) return [];

    let report: { vulnerabilities?: Record<string, { severity: string; name: string; via: unknown[] }> };
    try { report = JSON.parse(out); } catch { return []; }

    const findings: Finding[] = [];
    for (const [, vuln] of Object.entries(report.vulnerabilities ?? {})) {
      if (vuln.severity !== 'critical' && vuln.severity !== 'high') continue;
      findings.push({
        id: `npm-audit:${vuln.name}`,
        source: 'static-rules',
        severity: vuln.severity === 'critical' ? 'critical' : 'warning',
        category: 'npm-audit',
        file: 'package.json',
        message: `${vuln.severity.toUpperCase()} vulnerability in ${vuln.name}`,
        suggestion: `Run: npm audit fix`,
        protectedPath: false,
        createdAt: new Date().toISOString(),
      });
    }
    return findings;
  },
};
