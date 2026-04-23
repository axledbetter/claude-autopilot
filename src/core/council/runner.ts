import * as crypto from 'node:crypto';
import { windowContext } from './context.ts';
import type { CouncilConfig, CouncilResult, ModelResponse } from './types.ts';
import type { CouncilAdapter } from '../../adapters/council/types.ts';

async function consultWithTimeout(
  adapter: CouncilAdapter,
  prompt: string,
  context: string,
  timeoutMs: number,
): Promise<ModelResponse> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const text = await Promise.race([
      adapter.consult(prompt, context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { label: adapter.label, status: 'ok', text, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === 'timeout'
      ? { label: adapter.label, status: 'timeout', error: 'timed out', latencyMs: Date.now() - start }
      : { label: adapter.label, status: 'error', error: message, latencyMs: Date.now() - start };
  } finally {
    // Always clear the timer to avoid keeping the event loop alive after the
    // adapter resolves/rejects. Long-running hosts (MCP server) would accumulate
    // dangling timers for the full timeoutMs otherwise.
    if (timer) clearTimeout(timer);
  }
}

export async function runCouncil(
  config: CouncilConfig,
  adapters: CouncilAdapter[],
  synthesizer: CouncilAdapter,
  prompt: string,
  contextDoc: string,
): Promise<CouncilResult> {
  const run_id = crypto.randomUUID();
  const context = windowContext(contextDoc, config.parallelInputMaxTokens);

  const responses = await Promise.all(
    adapters.map(a => consultWithTimeout(a, prompt, context, config.timeoutMs))
  );

  const successful = responses.filter(r => r.status === 'ok');

  if (successful.length < config.minSuccessfulResponses) {
    return { schema_version: 1, run_id, status: 'failed', prompt, responses };
  }

  const responseSections = successful
    .map(r => `### ${r.label}\n${r.text}`)
    .join('\n\n');

  const synthesisDoc = `${contextDoc}\n\n---\n\n${responseSections}`;
  const synthesisCtx = windowContext(synthesisDoc, config.synthesisInputMaxTokens);
  const synthesisPrompt = [
    `You have received responses from multiple technical advisors on the following question:\n\n## Original Question\n\n${prompt}`,
    `## Advisor Responses\n\n${responseSections}`,
    'Based on these responses, provide a synthesis: areas of agreement, key disagreements, and your final recommendation.',
  ].join('\n\n');

  const synthStart = Date.now();
  try {
    const synthText = await synthesizer.consult(synthesisPrompt, synthesisCtx);
    const synthesis = { label: synthesizer.label, text: synthText, latencyMs: Date.now() - synthStart };
    return { schema_version: 1, run_id, status: 'success', prompt, responses, synthesis };
  } catch {
    return { schema_version: 1, run_id, status: 'partial', prompt, responses };
  }
}
