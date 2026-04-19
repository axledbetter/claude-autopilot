export type Severity = 'critical' | 'warning' | 'note';
export type FindingStatus = 'open' | 'fixed' | 'reverted' | 'human_required' | 'skipped';
export type PhaseStatus = 'pass' | 'fail' | 'warn' | 'skipped';
export type ValidationMode = 'pre-pr' | 'post-pr';
export type ValidationVerdict = 'PASS' | 'FAIL';

export interface Finding {
  id: string;
  phase: 'static' | 'autofix' | 'tests' | 'codex' | 'bugbot';
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  status: FindingStatus;
  fixAttempted: boolean;
  fixCommitSha?: string;
  protectedPath: boolean;
}

export interface PhaseResult {
  phase: string;
  status: PhaseStatus;
  findings: Finding[];
  durationMs: number;
}

export interface ValidationReport {
  reportVersion: 1;
  timestamp: string;
  branch: string;
  mergeBase: string;
  mode: ValidationMode;
  verdict: ValidationVerdict;
  phases: PhaseResult[];
  touchedFiles: string[];
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    blocking: number;
    autoFixed: number;
    humanRequired: number;
  };
}

export interface ValidateOptions {
  mode: ValidationMode;
  prNumber?: number;
  force: boolean;
  skipCodex: boolean;
  skipTests: boolean;
  commitAutofix: boolean;
  allowDirty: boolean;
  verbose: boolean;
  baseBranch: string;
}
