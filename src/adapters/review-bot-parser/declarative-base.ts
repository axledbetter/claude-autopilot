import type { Finding } from '../../core/findings/types.ts';
import type { GenericComment, VcsHost } from '../vcs-host/types.ts';
import type { Capabilities } from '../base.ts';
import type { ReviewBotParser } from './types.ts';

export interface DeclarativeParserConfig {
  name: string;
  author: string | RegExp;
  severityMap: { critical?: RegExp; warning?: RegExp; note?: RegExp };
  dismissalKeywords: string[];
}

export function makeDeclarativeParser(config: DeclarativeParserConfig): ReviewBotParser {
  const authorTest = typeof config.author === 'string'
    ? (a: string) => a === config.author
    : (a: string) => (config.author as RegExp).test(a);

  return {
    name: config.name,
    apiVersion: '1.0.0',

    getCapabilities(): Capabilities {
      return { structuredOutput: false, streaming: false, maxContextTokens: 0, inlineComments: true };
    },

    detect(comment: GenericComment): boolean {
      return authorTest(comment.author);
    },

    async fetchFindings(vcs: VcsHost, pr: number | string): Promise<Finding[]> {
      const comments = await vcs.getReviewComments(pr);
      const botComments = comments.filter(c => authorTest(c.author));
      return botComments.map((c, idx) => {
        const body = c.body ?? '';
        const severity = matchSeverity(body, config.severityMap);
        return {
          id: `${config.name}-${idx}-${c.id}`,
          source: `review-bot:${config.name}` as const,
          severity,
          category: `${config.name}-finding`,
          file: c.path ?? '<unspecified>',
          line: c.line,
          message: body.split('\n')[0]?.trim() ?? body,
          protectedPath: false,
          createdAt: new Date().toISOString(),
        };
      });
    },

    detectDismissal(reply: string): boolean {
      const lower = reply.toLowerCase();
      return config.dismissalKeywords.some(kw => lower.includes(kw));
    },
  };
}

function matchSeverity(
  body: string,
  map: DeclarativeParserConfig['severityMap']
): Finding['severity'] {
  if (map.critical && map.critical.test(body)) return 'critical';
  if (map.warning && map.warning.test(body)) return 'warning';
  return 'note';
}
