import type { Finding, FixAttempt, FixStatus } from '../findings/types.ts';
import { dedupFindings, findingContentKey } from '../findings/dedup.ts';

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

export async function runStaticRulesPhase(input: StaticRulesPhaseInput): Promise<StaticRulesPhaseResult> {
  const start = Date.now();

  const preFixFindings = dedupFindings(await runAllChecks(input.rules, input.touchedFiles));

  const fixAttempts: FixAttempt[] = [];
  let anyFixApplied = false;

  for (const finding of preFixFindings) {
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
    if (status === 'fixed') anyFixApplied = true;
    fixAttempts.push({ findingId: finding.id, attemptedAt: new Date().toISOString(), status });
  }

  // Re-check is the source of truth for what persists after autofix.
  // findings always returns preFixFindings so callers have a complete record;
  // fixAttempts + re-check set-difference tells them what was resolved.
  const postFixFindings = anyFixApplied
    ? dedupFindings(await runAllChecks(input.rules, input.touchedFiles))
    : preFixFindings;

  const postFixKeys = new Set(postFixFindings.map(findingContentKey));
  const isFixed = (f: Finding): boolean => !postFixKeys.has(findingContentKey(f));

  const unfixedCritical = preFixFindings.some(f => f.severity === 'critical' && !isFixed(f));
  const unfixedWarning = preFixFindings.some(f => f.severity === 'warning' && !isFixed(f));

  let status: StaticRulesPhaseResult['status'];
  if (unfixedCritical) status = 'fail';
  else if (unfixedWarning) status = 'warn';
  else status = 'pass';

  return { phase: 'static-rules', status, findings: preFixFindings, fixAttempts, durationMs: Date.now() - start };
}

async function runAllChecks(rules: StaticRule[], files: string[]): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const rule of rules) all.push(...(await rule.check(files)));
  return all;
}

function findRuleForFinding(rules: StaticRule[], finding: Finding): StaticRule | undefined {
  return rules.find(r => r.name === finding.category) ?? rules.find(r => finding.category.includes(r.name));
}
