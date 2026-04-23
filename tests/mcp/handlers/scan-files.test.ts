import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleScanFiles } from '../../../src/core/mcp/handlers/scan-files.ts';
import type { ReviewEngine, ReviewInput, ReviewOutput } from '../../../src/adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../../../src/core/config/types.ts';

function makeEngine(): ReviewEngine {
  return {
    name: 'mock', apiVersion: '1.0.0',
    getCapabilities: () => ({ structuredOutput: false, streaming: false, maxContextTokens: 128000, inlineComments: false }),
    estimateTokens: (c: string) => c.length,
    review: async (_: ReviewInput): Promise<ReviewOutput> => ({
      findings: [], rawOutput: '## Review Summary\nNo issues.', usage: undefined,
    }),
  };
}

const BASE_CONFIG: GuardrailConfig = { configVersion: 1 };

describe('handleScanFiles', () => {
  let tmp: string;

  it('returns run_id and findings for given files', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    const file = path.join(tmp, 'foo.ts');
    fs.writeFileSync(file, 'const x = 1;');
    const result = await handleScanFiles(
      { files: [file], cwd: tmp },
      BASE_CONFIG,
      makeEngine(),
    );
    assert.equal(result.schema_version, 1);
    assert.ok(typeof result.run_id === 'string');
    assert.ok(Array.isArray(result.findings));
    assert.ok(typeof result.human_summary === 'string');
    fs.rmSync(tmp, { recursive: true });
  });

  it('throws for files outside workspace', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    await assert.rejects(
      () => handleScanFiles({ files: ['/etc/passwd'], cwd: tmp }, BASE_CONFIG, makeEngine()),
      /outside workspace/,
    );
    fs.rmSync(tmp, { recursive: true });
  });
});
