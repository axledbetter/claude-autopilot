// src/core/council/config.ts
import { GuardrailError } from '../errors.ts';
import type { CouncilConfig, CouncilModelEntry } from './types.ts';

const SUPPORTED_ADAPTERS = new Set(['claude', 'openai']);

export function parseCouncilConfig(raw: Record<string, unknown>): CouncilConfig {
  const models = raw['models'] as Array<Record<string, string>> | undefined;
  const synthRaw = raw['synthesizer'] as Record<string, string> | undefined;
  const timeoutMs = (raw['timeout_ms'] as number | undefined) ?? 30000;
  const minSuccessful = (raw['min_successful_responses'] as number | undefined) ?? 1;
  const parallelInputMaxTokens = (raw['parallel_input_max_tokens'] as number | undefined) ?? 8000;
  const synthesisInputMaxTokens = (raw['synthesis_input_max_tokens'] as number | undefined) ?? 12000;

  if (!Array.isArray(models) || models.length < 2) {
    throw new GuardrailError('council.models must have at least 2 entries', { code: 'invalid_config' });
  }

  if (!synthRaw?.['adapter'] || !synthRaw['model'] || !synthRaw['label']) {
    throw new GuardrailError('council.synthesizer requires adapter, model, and label', { code: 'invalid_config' });
  }

  if (timeoutMs < 5000) {
    throw new GuardrailError(`council.timeout_ms must be >= 5000, got ${timeoutMs}`, { code: 'invalid_config' });
  }

  if (minSuccessful < 1 || minSuccessful > models.length) {
    throw new GuardrailError(
      `council.min_successful_responses must be 1–${models.length}, got ${minSuccessful}`,
      { code: 'invalid_config' },
    );
  }

  for (const entry of [...models, synthRaw]) {
    if (!SUPPORTED_ADAPTERS.has(entry['adapter']!)) {
      throw new GuardrailError(
        `council: unknown adapter "${entry['adapter']}" — supported: ${[...SUPPORTED_ADAPTERS].join(', ')}`,
        { code: 'invalid_config' },
      );
    }
  }

  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m['label']!)) {
      throw new GuardrailError(`council.models: duplicate label "${m['label']}"`, { code: 'invalid_config' });
    }
    seen.add(m['label']!);
  }

  const parsedModels: CouncilModelEntry[] = models.map(m => ({
    adapter: m['adapter'] as 'claude' | 'openai',
    model: m['model']!,
    label: m['label']!,
  }));

  const synthesizer: CouncilModelEntry = {
    adapter: synthRaw['adapter'] as 'claude' | 'openai',
    model: synthRaw['model']!,
    label: synthRaw['label']!,
  };

  return {
    models: parsedModels,
    synthesizer,
    timeoutMs,
    minSuccessfulResponses: minSuccessful,
    parallelInputMaxTokens,
    synthesisInputMaxTokens,
  };
}
