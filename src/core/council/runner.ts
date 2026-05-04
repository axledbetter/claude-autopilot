import * as crypto from 'node:crypto';
import { windowContext } from './context.ts';
import type { CouncilConfig, CouncilResult, ModelResponse } from './types.ts';
import type { CouncilAdapter, CouncilUsage } from '../../adapters/council/types.ts';

interface InternalResponse extends ModelResponse {
  usage?: CouncilUsage;
}

async function consultWithTimeout(
  adapter: CouncilAdapter,
  prompt: string,
  context: string,
  timeoutMs: number,
): Promise<InternalResponse> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const consultResult = await Promise.race([
      adapter.consult(prompt, context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return {
      label: adapter.label,
      status: 'ok',
      text: consultResult.text,
      latencyMs: Date.now() - start,
      usage: consultResult.usage,
    };
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

export interface CouncilRunOutput {
  result: CouncilResult;
  usage: { inputTokens: number; outputTokens: number; costUSD: number };
}

export async function runCouncil(
  config: CouncilConfig,
  adapters: CouncilAdapter[],
  synthesizer: CouncilAdapter,
  prompt: string,
  contextDoc: string,
): Promise<CouncilRunOutput> {
  const run_id = crypto.randomUUID();
  const context = windowContext(contextDoc, config.parallelInputMaxTokens);

  const responses = await Promise.all(
    adapters.map(a => consultWithTimeout(a, prompt, context, config.timeoutMs))
  );

  const aggregateUsage = (entries: InternalResponse[]) => {
    let inputTokens = 0, outputTokens = 0, costUSD = 0;
    for (const e of entries) {
      if (e.usage) {
        inputTokens += e.usage.input;
        outputTokens += e.usage.output;
        costUSD += e.usage.costUSD ?? 0;
      }
    }
    return { inputTokens, outputTokens, costUSD };
  };

  // Strip internal `usage` field before serializing to the public CouncilResult
  // schema — usage is summed and surfaced separately so the CLI can log it to
  // the cost ledger without leaking it into the JSON wire format.
  const publicResponses: ModelResponse[] = responses.map(({ usage: _u, ...rest }) => rest);
  const successful = responses.filter(r => r.status === 'ok');

  if (successful.length < config.minSuccessfulResponses) {
    return {
      result: { schema_version: 1, run_id, status: 'failed', prompt, responses: publicResponses },
      usage: aggregateUsage(responses),
    };
  }

  const responseSections = successful
    .map(r => `### ${r.label}\n${r.text}`)
    .join('\n\n');

  // Advisor responses go in synthesisPrompt only (structured form). The
  // context the synthesizer sees is the original conversation document
  // re-windowed for its own token budget — keeping responseSections out of
  // it avoids duplicating them and also avoids letting large responses
  // squeeze contextDoc out of synthesisInputMaxTokens.
  const synthesisCtx = windowContext(contextDoc, config.synthesisInputMaxTokens);
  const synthesisPrompt = [
    `You have received responses from multiple technical advisors on the following question:\n\n## Original Question\n\n${prompt}`,
    `## Advisor Responses\n\n${responseSections}`,
    'Based on these responses, provide a synthesis: areas of agreement, key disagreements, and your final recommendation.',
  ].join('\n\n');

  // Synthesizer shares the same per-call timeout as model calls so a hung
  // synthesizer API doesn't block the whole command indefinitely.
  const synthResponse = await consultWithTimeout(
    synthesizer,
    synthesisPrompt,
    synthesisCtx,
    config.timeoutMs,
  );
  const totalUsage = aggregateUsage([...responses, synthResponse]);

  // status:'ok' means the synthesizer call itself completed without error.
  // Empty text is valid (e.g. the --no-synthesize stub that intentionally
  // returns ''); only treat actual failures/timeouts as partial.
  if (synthResponse.status === 'ok') {
    const synthesis = { label: synthesizer.label, text: synthResponse.text ?? '', latencyMs: synthResponse.latencyMs };
    return {
      result: { schema_version: 1, run_id, status: 'success', prompt, responses: publicResponses, synthesis },
      usage: totalUsage,
    };
  }
  return {
    result: { schema_version: 1, run_id, status: 'partial', prompt, responses: publicResponses },
    usage: totalUsage,
  };
}
