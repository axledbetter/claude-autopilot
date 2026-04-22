import type { AdapterBase } from '../base.ts';
import type { Finding } from '../../core/findings/types.ts';

export interface ReviewInput {
  content: string;
  kind: 'spec' | 'pr-diff' | 'file-batch';
  context?: { spec?: string; plan?: string; stack?: string; cwd?: string };
}

export interface ReviewOutput {
  findings: Finding[];
  rawOutput: string;
  usage?: { input: number; output: number; costUSD?: number };
}

export interface ReviewEngine extends AdapterBase {
  review(input: ReviewInput): Promise<ReviewOutput>;
  estimateTokens(content: string): number;
}
