import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import type { Finding } from '../findings/types.ts';
import type { AutopilotConfig } from '../config/types.ts';

export interface IgnoreRule {
  ruleId: string | '*';  // finding id prefix or '*' for any
  pathGlob: string | null; // null = match all paths
}

export function loadIgnoreRules(cwd: string): IgnoreRule[] {
  const filePath = path.join(cwd, '.autopilot-ignore');
  if (!fs.existsSync(filePath)) return [];

  const rules: IgnoreRule[] = [];
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length === 1) {
      // bare glob — suppress any finding whose file matches
      rules.push({ ruleId: '*', pathGlob: parts[0]! });
    } else {
      // <rule-id-or-*> <path-glob>
      rules.push({ ruleId: parts[0]!, pathGlob: parts[1]! });
    }
  }
  return rules;
}

function matchesRule(finding: Finding, rule: IgnoreRule): boolean {
  const ruleMatches = rule.ruleId === '*' || finding.id.startsWith(rule.ruleId);
  if (!ruleMatches) return false;
  if (rule.pathGlob === null) return true;
  return minimatch(finding.file.replace(/\\/g, '/'), rule.pathGlob, { matchBase: true });
}

/** Convert `ignore:` entries from autopilot.config.yaml into IgnoreRules. */
export function parseConfigIgnore(entries: AutopilotConfig['ignore']): IgnoreRule[] {
  if (!entries || entries.length === 0) return [];
  return entries.map(entry => {
    if (typeof entry === 'string') {
      return { ruleId: '*', pathGlob: entry };
    }
    return { ruleId: entry.rule ?? '*', pathGlob: entry.path };
  });
}

export function applyIgnoreRules(findings: Finding[], rules: IgnoreRule[]): Finding[] {
  if (rules.length === 0) return findings;
  return findings.filter(f => !rules.some(r => matchesRule(f, r)));
}
