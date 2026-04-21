// src/core/findings/types.ts

export type FindingSource = 'static-rules' | 'review-engine' | 'pipeline' | `review-bot:${string}`;
export type Severity = 'critical' | 'warning' | 'note';

export interface Finding {
  id: string;
  source: FindingSource;
  severity: Severity;
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  protectedPath: boolean;
  createdAt: string;
}

export type TriageVerdict = 'real_bug' | 'false_positive' | 'low_value';
export type TriageAction = 'auto_fix' | 'propose_patch' | 'ask_question' | 'dismiss' | 'needs_human';

export interface TriageRecord {
  findingId: string;
  verdict: TriageVerdict;
  confidence: number;
  reason: string;
  action: TriageAction;
  recordedAt: string;
}

export type FixStatus = 'fixed' | 'reverted' | 'human_required' | 'skipped';

export interface FixAttempt {
  findingId: string;
  attemptedAt: string;
  status: FixStatus;
  commitSha?: string;
  notes?: string;
}
