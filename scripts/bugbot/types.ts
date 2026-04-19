export interface BugbotOptions {
  prNumber?: number;
  dryRun: boolean;
  rescan: boolean;
  verbose: boolean;
}

export interface BugbotComment {
  id: number;
  path: string;
  line?: number;
  body: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  url: string;
}

export type TriageAction = 'auto_fix' | 'dismiss' | 'propose_patch' | 'ask_question' | 'needs_human';
export type TriageVerdict = 'real_bug' | 'false_positive' | 'low_value';
export type ProcessedStatus = 'fixed' | 'needs-human' | 'ai-dismissed' | 'human-dismissed' | 'skipped' | 'proposed' | 'asked';

export interface TriageResult {
  commentId: number;
  action: TriageAction;
  verdict: TriageVerdict;
  confidence: number;
  reason: string;
  proposedPatch?: string;
}

export interface ProcessedEntry {
  status: ProcessedStatus;
  reason: string;
  commitSha?: string;
  triageResult?: TriageResult;
}

export interface BugbotState {
  prNumber: number;
  headSha: string;
  processed: Record<string, ProcessedEntry>;
  lockPid?: number;
}
