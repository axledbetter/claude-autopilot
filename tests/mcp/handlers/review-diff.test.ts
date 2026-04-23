import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleReviewDiff } from '../../../src/core/mcp/handlers/review-diff.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

function makeEngine(findings: any[] = []): ReviewEngine {
  return {
    name: 'mock',
    apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_input: ReviewInput): Promise<ReviewOutput> => ({
      findings,
      rawOutput: '## Review Summary\nAll good.',
      usage: undefined,
    }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleReviewDiff', () => {
  let tmp: string;

  it('returns schema_version:1, run_id string, findings array, human_summary string', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-test-'));
    // Use static_only:true to skip LLM and avoid git dependency in tests
    const result = await handleReviewDiff(
      { cwd: tmp, static_only: true },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.schema_version, 1);
    assert.ok(typeof result.run_id === 'string' && result.run_id.length > 0);
    assert.ok(Array.isArray(result.findings));
    assert.ok(typeof result.human_summary === 'string');
    fs.rmSync(tmp, { recursive: true });
  });
});
