import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  truncateDiff,
  summarizeFindings,
  parseDescription,
  runPrDesc,
} from '../src/cli/pr-desc.ts';
import type { Finding } from '../src/core/findings/types.ts';

function makeFinding(id: string, severity: Finding['severity'] = 'warning'): Finding {
  return {
    id, source: 'static-rules', category: 'test', file: 'src/a.ts', line: 1, severity,
    message: `Finding ${id}`, protectedPath: false, createdAt: new Date().toISOString(),
  };
}

const MOCK_ENGINE = {
  async review(_: { content: string; kind: string }) {
    return { rawOutput: 'Title: feat(test): add thing\n\n---\n## Summary\n- adds thing\n\n## Test Plan\n- [ ] verify thing' };
  },
};

describe('truncateDiff', () => {
  it('returns diff unchanged when under limit', () => {
    assert.equal(truncateDiff('short diff', 6000), 'short diff');
  });

  it('truncates at charLimit with marker', () => {
    const diff = 'x'.repeat(7000);
    const result = truncateDiff(diff, 6000);
    assert.ok(result.startsWith('x'.repeat(6000)));
    assert.ok(result.includes('[...truncated'));
  });

  it('uses default limit of 6000', () => {
    const result = truncateDiff('x'.repeat(7000));
    assert.ok(result.length < 7000);
    assert.ok(result.includes('[...truncated'));
  });
});

describe('summarizeFindings', () => {
  it('returns "None" when no findings', () => {
    assert.equal(summarizeFindings([]), 'None');
  });

  it('caps at max entries (default 10)', () => {
    const findings = Array.from({ length: 15 }, (_, i) => makeFinding(`f${i}`));
    const lines = summarizeFindings(findings).trim().split('\n');
    assert.equal(lines.length, 10);
  });

  it('sorts critical findings first', () => {
    const findings = [makeFinding('warn', 'warning'), makeFinding('crit', 'critical')];
    const result = summarizeFindings(findings);
    assert.ok(result.indexOf('crit') < result.indexOf('warn'));
  });
});

describe('parseDescription', () => {
  it('extracts title and body', () => {
    const raw = 'Title: feat(auth): add JWT rotation\n\n---\n## Summary\n- adds rotation';
    const { title, body } = parseDescription(raw);
    assert.equal(title, 'feat(auth): add JWT rotation');
    assert.ok(body.includes('## Summary'));
  });

  it('returns fallback title when Title: line is missing', () => {
    assert.equal(parseDescription('## Summary\n- no title').title, 'chore: update');
  });
});

describe('runPrDesc', () => {
  it('returns "No changes detected" when diff is empty', async () => {
    const result = await runPrDesc({
      _gitDiff: '',
      _branchName: 'feat/test',
      _cachedFindings: [],
      _reviewEngine: MOCK_ENGINE,
    });
    assert.equal(result.title, 'No changes detected');
  });

  it('generates title and body from LLM output', async () => {
    const result = await runPrDesc({
      _gitDiff: 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;',
      _branchName: 'feat/test',
      _cachedFindings: [],
      _reviewEngine: MOCK_ENGINE,
    });
    assert.equal(result.title, 'feat(test): add thing');
    assert.ok(result.body.includes('## Summary'));
  });

  it('includes [CRITICAL] in prompt when findings exist', async () => {
    let capturedContent = '';
    await runPrDesc({
      _gitDiff: 'diff line',
      _branchName: 'main',
      _cachedFindings: [makeFinding('f1', 'critical')],
      _reviewEngine: {
        async review(input) { capturedContent = input.content; return { rawOutput: 'Title: test\n\n---\nbody' }; },
      },
    });
    assert.ok(capturedContent.includes('[CRITICAL]'));
  });

  it('includes "None" in prompt when no findings', async () => {
    let capturedContent = '';
    await runPrDesc({
      _gitDiff: 'diff line',
      _branchName: 'main',
      _cachedFindings: [],
      _reviewEngine: {
        async review(input) { capturedContent = input.content; return { rawOutput: 'Title: test\n\n---\nbody' }; },
      },
    });
    assert.ok(capturedContent.includes('None'));
  });

  it('writes to --output file instead of stdout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-desc-'));
    const outPath = path.join(dir, 'pr.md');
    await runPrDesc({
      _gitDiff: 'diff line',
      _branchName: 'feat/x',
      _cachedFindings: [],
      _reviewEngine: MOCK_ENGINE,
      output: outPath,
    });
    const contents = fs.readFileSync(outPath, 'utf8');
    assert.ok(contents.includes('feat(test): add thing'));
    fs.rmSync(dir, { recursive: true });
  });
});
