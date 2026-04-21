import type { AdapterBase } from '../base.ts';

export interface GenericComment {
  id: string | number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
}

export interface PrMetadata {
  title: string;
  body: string;
  files: string[];
  headSha: string;
  baseRef: string;
  headRef: string;
}

export interface CreatePrOptions {
  title: string;
  body: string;
  base: string;
  head: string;
  draft?: boolean;
  idempotencyKey?: string;
}

export interface CreatePrResult {
  number: number;
  url: string;
  alreadyExisted: boolean;
}

export interface VcsHost extends AdapterBase {
  getPrDiff(pr: number | string): Promise<string>;
  getPrMetadata(pr: number | string): Promise<PrMetadata>;
  postComment(pr: number | string, body: string, idempotencyKey?: string): Promise<void>;
  getReviewComments(pr: number | string): Promise<GenericComment[]>;
  replyToComment(pr: number | string, commentId: string | number, body: string, idempotencyKey?: string): Promise<void>;
  createPr(opts: CreatePrOptions): Promise<CreatePrResult>;
  push(branch: string, opts?: { setUpstream?: boolean }): Promise<void>;
}
