import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('claudeAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    assert.equal(typeof claudeAdapter.review, 'function');
    assert.equal(typeof claudeAdapter.estimateTokens, 'function');
    assert.equal(typeof claudeAdapter.getCapabilities, 'function');
    assert.equal(claudeAdapter.name, 'claude');
    assert.equal(claudeAdapter.apiVersion, '1.0.0');
  });

  it('estimateTokens returns a positive integer', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    const tokens = claudeAdapter.estimateTokens('hello world this is a test string');
    assert.ok(tokens > 0);
    assert.equal(tokens, Math.ceil('hello world this is a test string'.length / 3.5));
  });

  it('getCapabilities includes maxContextTokens >= 200000', async () => {
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    const caps = claudeAdapter.getCapabilities();
    assert.ok((caps['maxContextTokens'] as number) >= 200000);
  });

  it('throws auth error when ANTHROPIC_API_KEY is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { claudeAdapter } = await import('../src/adapters/review-engine/claude.ts');
    try {
      await assert.rejects(
        () => claudeAdapter.review({ content: 'test', kind: 'file-batch' }),
        (err: Error) => err.message.includes('ANTHROPIC_API_KEY'),
      );
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('autoAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { autoAdapter } = await import('../src/adapters/review-engine/auto.ts');
    assert.equal(typeof autoAdapter.review, 'function');
    assert.equal(typeof autoAdapter.estimateTokens, 'function');
    assert.equal(autoAdapter.name, 'auto');
  });

  it('throws auth error when neither API key is set', async () => {
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { autoAdapter } = await import('../src/adapters/review-engine/auto.ts');
    try {
      await assert.rejects(
        () => autoAdapter.review({ content: 'test', kind: 'file-batch' }),
        (err: Error) => err.message.includes('No LLM API key'),
      );
    } finally {
      if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    }
  });
});

describe('adapter loader — claude and auto registration', () => {
  it('loads claude adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'claude' });
    assert.equal(adapter.name, 'claude');
  });

  it('loads auto adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'auto' });
    assert.equal(adapter.name, 'auto');
  });
});

describe('geminiAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { geminiAdapter } = await import('../src/adapters/review-engine/gemini.ts');
    assert.equal(typeof geminiAdapter.review, 'function');
    assert.equal(typeof geminiAdapter.estimateTokens, 'function');
    assert.equal(typeof geminiAdapter.getCapabilities, 'function');
    assert.equal(geminiAdapter.name, 'gemini');
  });

  it('getCapabilities reports maxContextTokens >= 1000000', async () => {
    const { geminiAdapter } = await import('../src/adapters/review-engine/gemini.ts');
    const caps = geminiAdapter.getCapabilities();
    assert.ok((caps['maxContextTokens'] as number) >= 1_000_000);
  });

  it('throws auth error when no Gemini key set', async () => {
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const { geminiAdapter } = await import('../src/adapters/review-engine/gemini.ts');
    try {
      await assert.rejects(
        () => geminiAdapter.review({ content: 'test', kind: 'file-batch' }),
        (err: Error) => err.message.includes('GEMINI_API_KEY'),
      );
    } finally {
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
    }
  });
});

describe('openaiCompatibleAdapter', () => {
  it('exports a ReviewEngine with required methods', async () => {
    const { openaiCompatibleAdapter } = await import('../src/adapters/review-engine/openai-compatible.ts');
    assert.equal(typeof openaiCompatibleAdapter.review, 'function');
    assert.equal(openaiCompatibleAdapter.name, 'openai-compatible');
  });

  it('throws invalid_config when model not set', async () => {
    const { openaiCompatibleAdapter } = await import('../src/adapters/review-engine/openai-compatible.ts');
    await assert.rejects(
      () => openaiCompatibleAdapter.review({ content: 'test', kind: 'file-batch' }),
      (err: Error) => err.message.includes('options.model'),
    );
  });
});

describe('adapter loader — gemini and openai-compatible registration', () => {
  it('loads gemini adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'gemini' });
    assert.equal(adapter.name, 'gemini');
  });

  it('loads openai-compatible adapter by name', async () => {
    const { loadAdapter } = await import('../src/adapters/loader.ts');
    const adapter = await loadAdapter({ point: 'review-engine', ref: 'openai-compatible' });
    assert.equal(adapter.name, 'openai-compatible');
  });
});

// ── parseReviewOutput ─────────────────────────────────────────────────────────
describe('parseReviewOutput', () => {
  it('extracts file:line from backtick reference', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [CRITICAL] Bad auth check
In \`app/api/auth/route.ts:42\` the token is not validated.
**Suggestion:** Add token validation.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, 'app/api/auth/route.ts');
    assert.equal(findings[0]!.line, 42);
  });

  it('extracts bare file:line reference', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [WARNING] Missing error handling
See services/foo.ts:10 for the call site.
**Suggestion:** Wrap in try/catch.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, 'services/foo.ts');
    assert.equal(findings[0]!.line, 10);
  });

  it('returns unspecified when no file ref in body', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [NOTE] Style issue
This function is too long.
**Suggestion:** Split it.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, '<unspecified>');
    assert.equal(findings[0]!.line, undefined);
  });

  it('does not treat version strings as file refs', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [NOTE] Upgrade dependency
Use v2.3.4 of this library.
**Suggestion:** Run npm install.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, '<unspecified>');
  });

  // Real-world bug: "e.g" and "i.e" matched the prior regex `\.[a-z]{1,6}`,
  // so every finding ended up with `file: "e.g"` and `claude-autopilot fix`
  // could never match anything to fix. The 5.0.4-pre stress test on
  // randai-johnson surfaced this — second-largest demo torpedo.
  it('does not treat "e.g." / "i.e." prose as file refs', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [WARNING] Missing input validation
The function accepts arbitrary types (e.g. dict, list) without validation.
**Suggestion:** Add type guards (i.e. isinstance checks).`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, '<unspecified>');
  });

  it('rejects bare references with non-code extensions like "etc"', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [NOTE] Path mention
See config.etc, or whatever.
**Suggestion:** Document it.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, '<unspecified>');
  });

  // 5.0.8 — line numbers can appear separately from the file ref. Without this
  // fallback, findings shipped with file but no line, which kills `fix`
  // (the fixer needs both for snippet extraction). This was the last YC-demo
  // torpedo from the 5.0.7 stress test.
  it('extracts "line N" from prose when not adjacent to file ref', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [WARNING] Hardcoded secret
In \`src/config.ts\`, on line 42 there's an API key in plaintext.
**Suggestion:** Move to env.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, 'src/config.ts');
    assert.equal(findings[0]!.line, 42);
  });

  it('prefers colon-line from file ref over separately-mentioned line', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [WARNING] Issue
In \`src/foo.ts:7\` there's a problem; also see line 99 of the same file.
**Suggestion:** Fix.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, 'src/foo.ts');
    assert.equal(findings[0]!.line, 7);
  });

  it('extracts "at line N" pattern', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [NOTE] Style issue
The file \`utils/helpers.ts\` has a problem at line 18.
**Suggestion:** Refactor.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings[0]!.file, 'utils/helpers.ts');
    assert.equal(findings[0]!.line, 18);
  });

  // Bugbot HIGH on PR #49 — JS regex alternation is leftmost-first, so when
  // shorter extensions appear before longer ones with the same prefix
  // (`c` before `cpp`, `h` before `hpp`, `md` before `mdx`, `m` before `mm`,
  // `d` before `dart`), `file.cpp:42` matched as `file.c` and the line number
  // was silently dropped. Pins extensions ordered longest-first.
  it('matches cpp/hpp/mdx/dart/mm fully (regex alternation order regression)', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const cases = [
      { ext: 'cpp', body: 'In src/runtime/buffer.cpp:42 the deque overflows.' },
      { ext: 'hpp', body: 'See include/lib.hpp:88 for the macro.' },
      { ext: 'mdx', body: 'Edit docs/index.mdx:3 to fix.' },
      { ext: 'dart', body: 'In lib/main.dart:120 use late.' },
      { ext: 'mm',  body: 'See ios/AppDelegate.mm:55 for setup.' },
      { ext: 'jsonc', body: 'Tweak .vscode/settings.jsonc:7.' },
    ];
    for (const { ext, body } of cases) {
      const findings = parseReviewOutput(`### [WARNING] x\n${body}\n**Suggestion:** y`, 'test');
      assert.ok(findings[0]!.file.endsWith(`.${ext}`), `expected file to end .${ext}, got: ${findings[0]!.file}`);
      assert.ok(findings[0]!.line && findings[0]!.line > 0, `expected line for .${ext}, got: ${findings[0]!.line}`);
    }
  });

  it('parses multiple findings with correct ids', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [CRITICAL] Issue one
Body one.
### [WARNING] Issue two
Body two.`;
    const findings = parseReviewOutput(output, 'myprefix');
    assert.equal(findings.length, 2);
    assert.equal(findings[0]!.id, 'myprefix-0');
    assert.equal(findings[1]!.id, 'myprefix-1');
    assert.equal(findings[0]!.severity, 'critical');
    assert.equal(findings[1]!.severity, 'warning');
  });

  // Format-drift tolerance. Before 4.0.1 the regex required literal `### [CRITICAL]`
  // brackets and silently returned zero findings on any other variant — the single
  // biggest quality risk flagged in external review. These tests pin the parser to
  // accept what models actually emit.

  it('parses unbracketed severity: ### CRITICAL title', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### CRITICAL SQL injection in query builder
In \`db/query.ts:88\` user input concatenated into SQL.
**Suggestion:** Use parameterized query.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'critical');
    assert.equal(findings[0]!.file, 'db/query.ts');
    assert.equal(findings[0]!.line, 88);
  });

  it('parses bold severity: ### **CRITICAL** title', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### **CRITICAL** Missing auth on mutation
In \`api/users/route.ts:12\` POST route lacks auth.
**Suggestion:** Add getServerSession check.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'critical');
    assert.equal(findings[0]!.file, 'api/users/route.ts');
  });

  it('parses bold+bracketed severity: ### **[CRITICAL]** title', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### **[CRITICAL]** Hardcoded secret
See config/secrets.ts:3.
**Suggestion:** Move to env var.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'critical');
  });

  it('parses mixed variants across findings', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const output = `### [CRITICAL] Bracketed first
Body A.
### CRITICAL Unbracketed second
Body B.
### **WARNING** Bold third
Body C.`;
    const findings = parseReviewOutput(output, 'test');
    assert.equal(findings.length, 3);
    assert.equal(findings[0]!.severity, 'critical');
    assert.equal(findings[1]!.severity, 'critical');
    assert.equal(findings[2]!.severity, 'warning');
  });

  it('warns when raw output is non-empty but no findings parse', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    // Capture console.warn
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      // Real Llama-style drift: prose review with no ### heading at all
      const output = `I reviewed the code and found several issues. First, the auth handler is missing a check. Second, the SQL query is vulnerable. See authHandler.ts for details.`;
      const findings = parseReviewOutput(output, 'test');
      assert.equal(findings.length, 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /no findings parsed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not warn on empty output', async () => {
    const { parseReviewOutput } = await import('../src/adapters/review-engine/parse-output.ts');
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      assert.equal(parseReviewOutput('', 'test').length, 0);
      assert.equal(parseReviewOutput('   \n  ', 'test').length, 0);
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
