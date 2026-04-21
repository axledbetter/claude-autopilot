import * as path from 'node:path';
import type { RunResult } from '../core/pipeline/run.ts';
import type { Finding } from '../core/findings/types.ts';

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}
interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}
interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}
interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
}
interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
  fixes?: Array<{ description: { text: string } }>;
}
interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: { startLine: number };
  };
}

export type { SarifLog };

export function normalizeSarifUri(file: string, cwd: string): string {
  let rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  rel = rel.replace(/\\/g, '/');
  if (rel.startsWith('./')) rel = rel.slice(2);
  if (rel.startsWith('../')) rel = file.replace(/\\/g, '/');
  return rel;
}

function severityToLevel(s: Finding['severity']): 'error' | 'warning' | 'note' {
  if (s === 'critical') return 'error';
  if (s === 'warning') return 'warning';
  return 'note';
}

export function toSarif(
  result: RunResult,
  opts: { toolVersion: string; cwd?: string },
): SarifLog {
  const cwd = opts.cwd ?? process.cwd();

  const rulesMap = new Map<string, SarifRule>();
  for (const f of result.allFindings) {
    if (!rulesMap.has(f.category)) {
      rulesMap.set(f.category, {
        id: f.category,
        name: f.category,
        shortDescription: { text: f.category },
      });
    }
  }

  const results: SarifResult[] = result.allFindings.map(f => {
    const r: SarifResult = {
      ruleId: f.category,
      level: severityToLevel(f.severity),
      message: { text: f.message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: normalizeSarifUri(f.file, cwd), uriBaseId: '%SRCROOT%' },
          ...(f.line !== undefined ? { region: { startLine: f.line } } : {}),
        },
      }],
    };
    if (f.suggestion) r.fixes = [{ description: { text: f.suggestion } }];
    return r;
  });

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'claude-autopilot',
          version: opts.toolVersion,
          informationUri: 'https://github.com/axledbetter/claude-autopilot',
          rules: [...rulesMap.values()],
        },
      },
      results,
    }],
  };
}
