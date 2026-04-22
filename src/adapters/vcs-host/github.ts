import { runSafe, runThrowing } from '../../core/shell.ts';
import { GuardrailError } from '../../core/errors.ts';
import type { Capabilities } from '../base.ts';
import type { VcsHost, GenericComment, PrMetadata, CreatePrOptions, CreatePrResult } from './types.ts';

export const githubAdapter: VcsHost = {
  name: 'github',
  apiVersion: '1.0.0',

  getCapabilities(): Capabilities {
    return { structuredOutput: true, streaming: false, maxContextTokens: 0, inlineComments: true };
  },

  async getPrDiff(pr: number | string): Promise<string> {
    const result = runSafe('gh', ['pr', 'diff', String(pr)]);
    if (result === null) throw new GuardrailError(`Failed to get diff for PR ${pr}`, { code: 'transient_network' });
    return result;
  },

  async getPrMetadata(pr: number | string): Promise<PrMetadata> {
    const raw = runThrowing('gh', ['pr', 'view', String(pr), '--json', 'title,body,files,headRefOid,baseRefName,headRefName'], { errorCode: 'transient_network' });
    const data = JSON.parse(raw) as { title: string; body: string; files: { path: string }[]; headRefOid: string; baseRefName: string; headRefName: string };
    return {
      title: data.title,
      body: data.body ?? '',
      files: (data.files ?? []).map((f: { path: string }) => f.path),
      headSha: data.headRefOid,
      baseRef: data.baseRefName,
      headRef: data.headRefName,
    };
  },

  async postComment(pr: number | string, body: string): Promise<void> {
    runThrowing('gh', ['pr', 'comment', String(pr), '--body', body], { errorCode: 'transient_network' });
  },

  async getReviewComments(pr: number | string): Promise<GenericComment[]> {
    const raw = runSafe('gh', ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '--paginate']);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Array<{ id: number; user: { login: string }; body: string; path: string; line?: number; html_url: string }>;
      return parsed.map(c => ({ id: c.id, author: c.user.login, body: c.body, path: c.path, line: c.line, url: c.html_url }));
    } catch { return []; }
  },

  async replyToComment(pr: number | string, commentId: string | number, body: string): Promise<void> {
    runThrowing('gh', ['api', `repos/{owner}/{repo}/pulls/${pr}/comments/${commentId}/replies`, '--method', 'POST', '--field', `body=${body}`], { errorCode: 'transient_network' });
  },

  async createPr(opts: CreatePrOptions): Promise<CreatePrResult> {
    const existing = runSafe('gh', ['pr', 'list', '--head', opts.head, '--json', 'number,url', '--limit', '1']);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as Array<{ number: number; url: string }>;
        if (parsed.length > 0 && parsed[0]) {
          return { number: parsed[0].number, url: parsed[0].url, alreadyExisted: true };
        }
      } catch { /* fall through to create */ }
    }

    const args = ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', opts.base, '--head', opts.head];
    if (opts.draft) args.push('--draft');
    const raw = runThrowing('gh', args, { errorCode: 'transient_network' });
    const url = raw.trim();
    const match = url.match(/\/pull\/(\d+)$/);
    const number = match ? parseInt(match[1]!, 10) : 0;
    return { number, url, alreadyExisted: false };
  },

  async push(branch: string, opts?: { setUpstream?: boolean }): Promise<void> {
    const args = ['push', 'origin', branch];
    if (opts?.setUpstream) args.splice(1, 0, '-u');
    runThrowing('git', args, { errorCode: 'transient_network' });
  },
};

export default githubAdapter;
