import { createHash } from 'node:crypto';

export function idempotencyKey(runId: string, step: string, inputs: Record<string, unknown>): string {
  const serialized = JSON.stringify({ runId, step, inputs });
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}
