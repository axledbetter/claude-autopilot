import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../adapters/review-engine/types.ts';
import type { Capabilities } from '../../adapters/base.ts';
import { ReviewCache, type ReviewCacheOptions } from './review-cache.ts';

/**
 * Wraps any ReviewEngine with file-based response caching.
 * Cache key = SHA-256(adapterName + model + content).
 */
export function withCache(engine: ReviewEngine, options: ReviewCacheOptions = {}): ReviewEngine {
  const cache = new ReviewCache(options);
  const model = (engine as { model?: string }).model ?? engine.name;

  return {
    name: engine.name,
    apiVersion: engine.apiVersion,
    getCapabilities(): Capabilities {
      return engine.getCapabilities();
    },
    estimateTokens(content: string): number {
      return engine.estimateTokens(content);
    },
    async review(input: ReviewInput): Promise<ReviewOutput> {
      const keyPayload = `${input.content}\x00${input.kind}\x00${input.context?.stack ?? ''}`;
      const key = ReviewCache.keyFor(engine.name, model, keyPayload);
      const cached = await cache.get(key);
      if (cached) return { ...cached, usage: cached.usage ? { ...cached.usage, costUSD: 0 } : undefined };
      const output = await engine.review(input);
      await cache.set(key, output);
      return output;
    },
  };
}
