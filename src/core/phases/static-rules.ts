import type { Finding, FixAttempt, FixStatus } from '../findings/types.ts';
import { dedupFindings } from '../findings/dedup.ts';

export interface StaticRule {
  name: string;
  severity: 'critical' | 'warning' | 'note';
  check(touchedFiles: string[]): Promise<Finding[]>;
  autofix?(finding: Finding): Promise<FixStatus>;
}

export interface StaticRulesPhaseInput {
  touchedFiles: string[];
  rules: StaticRule[];
}

export interface StaticRulesPhaseResult {
  phase: 'static-rules';
  status: 'pass' | 'warn' | 'fail';
  findings: Finding[];
  fixAttempts: FixAttempt[];
  durationMs: number;
}

function contentKey(f: Finding): string {
  return `${f.file}|${f.line ?? ''}|${f.severity}|${f.message.slice(0, 40)}`;
}

export async function runStaticRulesPhase(input: StaticRulesPhaseInput): Promise<StaticRulesPhaseResult> {
  const start = Date.now();

  let findings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles));

  const fixAttempts: FixAttempt[] = [];
  let anyFixApplied = false;
  const fixedContentKeys = new Set<string>();

  for (const finding of findings) {
    const rule = findRuleForFinding(input.rules, finding);
    if (!rule?.autofix) continue;

    if (finding.protectedPath) {
      fixAttempts.push({
        findingId: finding.id,
        attemptedAt: new Date().toISOString(),
        status: 'skipped',
        notes: 'protected path',
      });
      continue;
    }

    const status = await rule.autofix(finding);
    if (status === 'fixed') {
      anyFixApplied = true;
      fixedContentKeys.add(contentKey(finding));
    }
    fixAttempts.push({ findingId: finding.id, attemptedAt: new Date().toISOString(), status });
  }

  if (anyFixApplied) {
    findings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles));
  }

  const isFixed = (f: Finding): boolean => fixedContentKeys.has(contentKey(f));
  const unfixedCritical = findings.some(f => f.severity === 'critical' && !isFixed(f));
  const unfixedWarning = findings.some(f => f.severity === 'warning' && !isFixed(f));

  let status: StaticRulesPhaseResult['status'];
  if (unfixedCritical) status = 'fail';
  else if (unfixedWarning) status = 'warn';
  else status = 'pass';

  return { phase: 'static-rules', status, findings, fixAttempts, durationMs: Date.now() - start };
}

async function runAllChecks(rules: StaticRule[], files: string[]): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const rule of rules) all.push(...(await rule.check(files)));
  return all;
}

function findRuleForFinding(rules: StaticRule[], finding: Finding): StaticRule | undefined {
  return rules.find(r => r.name === finding.category) ?? rules.find(r => finding.category.includes(r.name));
}
