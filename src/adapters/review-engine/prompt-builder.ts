import type { ReviewInput } from './types.ts';

const DEFAULT_STACK = 'A web application — stack details unspecified.';

export function buildSystemPrompt(input: ReviewInput, template: string): string {
  const stack = input.context?.stack ?? DEFAULT_STACK;
  const gitCtx = input.context?.gitSummary ? `\n\nChange context: ${input.context.gitSummary}` : '';
  const designBlock = input.context?.designSchema ? `\n\n${input.context.designSchema}` : '';
  return template
    .replace('{STACK}', stack)
    .replace('{GIT_CONTEXT}', gitCtx)
    .replace('{DESIGN_SCHEMA}', designBlock);
}

export function classifyError(message: string): 'auth' | 'rate_limit' | 'transient_network' {
  if (/unauthorized|401|invalid\.api\.key|authentication|api\.key|403/i.test(message)) return 'auth';
  if (/rate.limit|429|overloaded|quota/i.test(message)) return 'rate_limit';
  return 'transient_network';
}
