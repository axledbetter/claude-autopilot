# guardrail council Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `guardrail council` command that sends a prompt + session context doc to multiple configured LLMs in parallel, then synthesizes their responses into a single recommendation.

**Architecture:** Parallel dispatch via `Promise.allSettled` + per-model timeout races; quorum check before synthesis; synthesizer receives all successful responses + original context. JSON emitted to stdout, markdown rendering is caller's responsibility.

**Tech Stack:** TypeScript ESM, `node:test`, `@anthropic-ai/sdk`, `openai`, AJV JSON Schema (project-standard, not Zod), no new dependencies.

---

## File Map

### New files
| File | Responsibility |
|------|----------------|
| `src/core/council/types.ts` | `CouncilConfig`, `CouncilResult`, `ModelResponse`, `SynthesisResponse` |
| `src/adapters/council/types.ts` | `CouncilAdapter` interface |
| `src/core/council/context.ts` | Session doc windowing (token budget, top-truncation) |
| `src/core/council/config.ts` | `parseCouncilConfig(raw) → CouncilConfig` with defaults + validation |
| `src/core/council/runner.ts` | `runCouncil(...)` — parallel dispatch, quorum, synthesis |
| `src/adapters/council/claude.ts` | `makeClaudeCouncilAdapter(model, label)` |
| `src/adapters/council/openai.ts` | `makeOpenAICouncilAdapter(model, label)` |
| `src/cli/council.ts` | CLI entry: arg parsing, adapter creation, output |
| `tests/council/context.test.ts` | windowContext unit tests |
| `tests/council/config.test.ts` | parseCouncilConfig unit tests |
| `tests/council/runner.test.ts` | runCouncil unit tests (mock adapters) |

### Modified files
| File | Change |
|------|--------|
| `src/core/config/types.ts` | Add `council?` field to `GuardrailConfig` |
| `src/core/config/schema.ts` | Add `council` JSON Schema entry |
| `src/cli/index.ts` | Add `import` + `case 'council':` dispatch |

---

## Task 1: Types

**Files:**
- Create: `src/core/council/types.ts`
- Create: `src/adapters/council/types.ts`

- [ ] **Step 1: Write `src/core/council/types.ts`**

```typescript
// src/core/council/types.ts

export interface CouncilModelEntry {
  adapter: 'claude' | 'openai';
  model: string;
  label: string;
}

export interface CouncilConfig {
  models: CouncilModelEntry[];
  synthesizer: CouncilModelEntry;
  timeoutMs: number;
  minSuccessfulResponses: number;
  parallelInputMaxTokens: number;
  synthesisInputMaxTokens: number;
}

export type ModelResponseStatus = 'ok' | 'timeout' | 'error';

export interface ModelResponse {
  label: string;
  status: ModelResponseStatus;
  text?: string;
  error?: string;
  latencyMs: number;
}

export interface SynthesisResponse {
  label: string;
  text: string;
  latencyMs: number;
}

export type CouncilStatus = 'success' | 'partial' | 'failed';

export interface CouncilResult {
  schema_version: 1;
  run_id: string;
  status: CouncilStatus;
  prompt: string;
  responses: ModelResponse[];
  synthesis?: SynthesisResponse;
}
```

- [ ] **Step 2: Write `src/adapters/council/types.ts`**

```typescript
// src/adapters/council/types.ts
export interface CouncilAdapter {
  readonly label: string;
  consult(prompt: string, context: string): Promise<string>;
}
```

- [ ] **Step 3: Verify types compile**

Run: `cd /path/to/worktree && npx tsc --noEmit 2>&1 | head -20`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/core/council/types.ts src/adapters/council/types.ts
git commit -m "feat(council): add type definitions"
```

---

## Task 2: Context Windowing

**Files:**
- Create: `src/core/council/context.ts`
- Create: `tests/council/context.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/context.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { windowContext } from '../../src/core/council/context.ts';

describe('windowContext', () => {
  it('C1: returns text unchanged when under budget', () => {
    const text = 'short doc';
    // 9 chars / 4 ≈ 3 tokens — well under 10000 budget
    assert.equal(windowContext(text, 10000), text);
  });

  it('C2: truncates from top when over budget', () => {
    // 2000 chars / 4 = 500 tokens — over budget of 250 tokens (1000 chars budget)
    const text = 'A'.repeat(1000) + 'B'.repeat(1000);
    const result = windowContext(text, 250);
    assert.ok(result.includes('<!-- [council: truncated'));
    // Keeps most recent content (B's), drops oldest (A's)
    assert.ok(result.endsWith('B'.repeat(1000)));
    assert.ok(!result.startsWith('A'));
  });

  it('C3: exactly at budget — no truncation', () => {
    // 400 chars / 4 = 100 tokens exactly
    const text = 'X'.repeat(400);
    assert.equal(windowContext(text, 100), text);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/council/context.test.ts 2>&1`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write `src/core/council/context.ts`**

```typescript
// src/core/council/context.ts
const CHARS_PER_TOKEN = 4;

export function windowContext(text: string, maxTokens: number): string {
  const estimated = Math.ceil(text.length / CHARS_PER_TOKEN);
  if (estimated <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const charsDropped = text.length - maxChars;
  const marker = `<!-- [council: truncated ${charsDropped} chars] -->\n`;
  process.stderr.write(`[council] context truncated: dropped ${charsDropped} chars to fit ${maxTokens} token budget\n`);
  return marker + text.slice(charsDropped);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/council/context.test.ts 2>&1`
Expected: 3 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/council/context.ts tests/council/context.test.ts
git commit -m "feat(council): add context windowing"
```

---

## Task 3: Config Schema + Parser

**Files:**
- Create: `src/core/council/config.ts`
- Modify: `src/core/config/types.ts`
- Modify: `src/core/config/schema.ts`
- Create: `tests/council/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/config.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCouncilConfig } from '../../src/core/council/config.ts';
import { GuardrailError } from '../../src/core/errors.ts';

const validRaw = {
  models: [
    { adapter: 'claude', model: 'claude-opus-4-7', label: 'Claude' },
    { adapter: 'openai', model: 'gpt-5.4', label: 'Codex' },
  ],
  synthesizer: { adapter: 'claude', model: 'claude-opus-4-7', label: 'Synthesizer' },
};

describe('parseCouncilConfig', () => {
  it('CC1: parses valid config and applies defaults', () => {
    const cfg = parseCouncilConfig(validRaw);
    assert.equal(cfg.timeoutMs, 30000);
    assert.equal(cfg.minSuccessfulResponses, 1);
    assert.equal(cfg.parallelInputMaxTokens, 8000);
    assert.equal(cfg.synthesisInputMaxTokens, 12000);
    assert.equal(cfg.models.length, 2);
    assert.equal(cfg.models[0]!.label, 'Claude');
    assert.equal(cfg.synthesizer.label, 'Synthesizer');
  });

  it('CC2: throws on fewer than 2 models', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [{ adapter: 'claude', model: 'x', label: 'A' }],
        synthesizer: { adapter: 'claude', model: 'x', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC3: throws on duplicate labels in models', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [
          { adapter: 'claude', model: 'x', label: 'Same' },
          { adapter: 'openai', model: 'y', label: 'Same' },
        ],
        synthesizer: { adapter: 'claude', model: 'x', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC4: throws on unknown adapter name', () => {
    assert.throws(
      () => parseCouncilConfig({
        models: [
          { adapter: 'unknown', model: 'x', label: 'A' },
          { adapter: 'claude', model: 'y', label: 'B' },
        ],
        synthesizer: { adapter: 'claude', model: 'y', label: 'S' },
      }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC5: throws when min_successful_responses > models.length', () => {
    assert.throws(
      () => parseCouncilConfig({ ...validRaw, min_successful_responses: 5 }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });

  it('CC6: throws when timeout_ms < 5000', () => {
    assert.throws(
      () => parseCouncilConfig({ ...validRaw, timeout_ms: 100 }),
      (e: unknown) => { assert.ok(e instanceof GuardrailError); return true; }
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/council/config.test.ts 2>&1`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Add `council?` to `GuardrailConfig` in `src/core/config/types.ts`**

Inside the `GuardrailConfig` interface, before the closing `}`, add:

```typescript
  council?: {
    models: Array<{ adapter: string; model: string; label: string }>;
    synthesizer: { adapter: string; model: string; label: string };
    timeout_ms?: number;
    min_successful_responses?: number;
    parallel_input_max_tokens?: number;
    synthesis_input_max_tokens?: number;
  };
```

- [ ] **Step 4: Add `council` JSON Schema to `src/core/config/schema.ts`**

Inside the `properties` object (after `concurrency`), add:

```typescript
    council: {
      type: 'object',
      required: ['models', 'synthesizer'],
      additionalProperties: false,
      properties: {
        models: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['adapter', 'model', 'label'],
            additionalProperties: false,
            properties: {
              adapter: { type: 'string' },
              model: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
        synthesizer: {
          type: 'object',
          required: ['adapter', 'model', 'label'],
          additionalProperties: false,
          properties: {
            adapter: { type: 'string' },
            model: { type: 'string' },
            label: { type: 'string' },
          },
        },
        timeout_ms: { type: 'number' },
        min_successful_responses: { type: 'number' },
        parallel_input_max_tokens: { type: 'number' },
        synthesis_input_max_tokens: { type: 'number' },
      },
    },
```

- [ ] **Step 5: Write `src/core/council/config.ts`**

```typescript
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
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test tests/council/config.test.ts 2>&1`
Expected: 6 passing, 0 failing

- [ ] **Step 7: Commit**

```bash
git add src/core/council/config.ts src/core/config/types.ts src/core/config/schema.ts tests/council/config.test.ts
git commit -m "feat(council): add config schema and parser"
```

---

## Task 4: Council Adapters

**Files:**
- Create: `src/adapters/council/claude.ts`
- Create: `src/adapters/council/openai.ts`

(No separate tests — adapters make live API calls; tested end-to-end in the runner tests via mocks)

- [ ] **Step 1: Write `src/adapters/council/claude.ts`**

```typescript
// src/adapters/council/claude.ts
import Anthropic from '@anthropic-ai/sdk';
import { GuardrailError } from '../../core/errors.ts';
import type { CouncilAdapter } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

export function makeClaudeCouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<string> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('ANTHROPIC_API_KEY not set', { code: 'auth', provider: 'claude' });
      }
      const client = new Anthropic({ apiKey });
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `## Context\n\n${context}\n\n## Question\n\n${prompt}` }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GuardrailError(`Claude council call failed: ${message}`, {
          code: 'transient_network',
          provider: 'claude',
        });
      }
      return response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');
    },
  };
}
```

- [ ] **Step 2: Write `src/adapters/council/openai.ts`**

```typescript
// src/adapters/council/openai.ts
import OpenAI from 'openai';
import { GuardrailError } from '../../core/errors.ts';
import type { CouncilAdapter } from './types.ts';

const SYSTEM_PROMPT = `You are a technical advisor reviewing a software design decision. Evaluate the provided context and question critically. Be direct and specific. Surface tradeoffs, risks, and your recommendation.`;
const MAX_OUTPUT_TOKENS = 2048;

export function makeOpenAICouncilAdapter(model: string, label: string): CouncilAdapter {
  return {
    label,
    async consult(prompt: string, context: string): Promise<string> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new GuardrailError('OPENAI_API_KEY not set', { code: 'auth', provider: 'openai' });
      }
      const client = new OpenAI({ apiKey });
      let response: OpenAI.ChatCompletion;
      try {
        response = await client.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `## Context\n\n${context}\n\n## Question\n\n${prompt}` },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GuardrailError(`OpenAI council call failed: ${message}`, {
          code: 'transient_network',
          provider: 'openai',
        });
      }
      return response.choices[0]?.message?.content ?? '';
    },
  };
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit 2>&1 | grep "council" | head -10`
Expected: no errors on council files

- [ ] **Step 4: Commit**

```bash
git add src/adapters/council/claude.ts src/adapters/council/openai.ts
git commit -m "feat(council): add Claude and OpenAI council adapters"
```

---

## Task 5: Council Runner

**Files:**
- Create: `src/core/council/runner.ts`
- Create: `tests/council/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/council/runner.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCouncil } from '../../src/core/council/runner.ts';
import type { CouncilConfig } from '../../src/core/council/types.ts';
import type { CouncilAdapter } from '../../src/adapters/council/types.ts';

function makeAdapter(label: string, response: string, delayMs = 0): CouncilAdapter {
  return {
    label,
    async consult(): Promise<string> {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return response;
    },
  };
}

function makeFailingAdapter(label: string): CouncilAdapter {
  return {
    label,
    async consult(): Promise<string> { throw new Error('api error'); },
  };
}

const baseConfig: CouncilConfig = {
  models: [
    { adapter: 'claude', model: 'x', label: 'A' },
    { adapter: 'openai', model: 'y', label: 'B' },
  ],
  synthesizer: { adapter: 'claude', model: 'x', label: 'Synth' },
  timeoutMs: 500,
  minSuccessfulResponses: 1,
  parallelInputMaxTokens: 8000,
  synthesisInputMaxTokens: 12000,
};

describe('runCouncil', () => {
  it('R1: all succeed — status success, synthesis present', async () => {
    const adapters = [makeAdapter('A', 'response A'), makeAdapter('B', 'response B')];
    const synthesizer = makeAdapter('Synth', 'the synthesis text');
    const result = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
    assert.equal(result.schema_version, 1);
    assert.equal(result.status, 'success');
    assert.equal(result.responses.length, 2);
    assert.ok(result.responses.every(r => r.status === 'ok'));
    assert.ok(result.synthesis?.text.includes('the synthesis text'));
    assert.ok(typeof result.run_id === 'string' && result.run_id.length > 0);
  });

  it('R2: one model times out — quorum still met, synthesis runs', async () => {
    // A takes 600ms, timeout is 500ms → A times out; B succeeds; min=1 → quorum met
    const adapters = [makeAdapter('A', 'response A', 600), makeAdapter('B', 'response B')];
    const synthesizer = makeAdapter('Synth', 'synthesis text');
    const result = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
    assert.equal(result.status, 'success');
    const timedOut = result.responses.find(r => r.label === 'A');
    const ok = result.responses.find(r => r.label === 'B');
    assert.equal(timedOut?.status, 'timeout');
    assert.equal(ok?.status, 'ok');
    assert.ok(result.synthesis !== undefined);
  });

  it('R3: all models fail — status failed, no synthesis', async () => {
    const adapters = [makeFailingAdapter('A'), makeFailingAdapter('B')];
    const synthesizer = makeAdapter('Synth', 'synthesis');
    const result = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
    assert.equal(result.status, 'failed');
    assert.equal(result.synthesis, undefined);
    assert.ok(result.responses.every(r => r.status === 'error'));
  });

  it('R4: quorum not met with stricter config — status failed', async () => {
    const strictConfig = { ...baseConfig, minSuccessfulResponses: 2 };
    const adapters = [makeFailingAdapter('A'), makeAdapter('B', 'ok B')];
    const synthesizer = makeAdapter('Synth', 'synthesis');
    const result = await runCouncil(strictConfig, adapters, synthesizer, 'test prompt', 'context');
    assert.equal(result.status, 'failed');
    assert.equal(result.synthesis, undefined);
  });

  it('R5: synthesis throws — status partial, responses present', async () => {
    const adapters = [makeAdapter('A', 'response A'), makeAdapter('B', 'response B')];
    const failSynth = makeFailingAdapter('Synth');
    const result = await runCouncil(baseConfig, adapters, failSynth, 'test prompt', 'context doc');
    assert.equal(result.status, 'partial');
    assert.equal(result.responses.filter(r => r.status === 'ok').length, 2);
    assert.equal(result.synthesis, undefined);
  });

  it('R6: latencyMs is measured for each response', async () => {
    const adapters = [makeAdapter('A', 'r', 50), makeAdapter('B', 'r', 50)];
    const synthesizer = makeAdapter('Synth', 's');
    const result = await runCouncil(baseConfig, adapters, synthesizer, 'q', 'ctx');
    assert.ok(result.responses.every(r => r.latencyMs >= 50));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/council/runner.test.ts 2>&1`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write `src/core/council/runner.ts`**

```typescript
// src/core/council/runner.ts
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
  try {
    const text = await Promise.race([
      adapter.consult(prompt, context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ]);
    return { label: adapter.label, status: 'ok', text, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === 'timeout'
      ? { label: adapter.label, status: 'timeout', error: 'timed out', latencyMs: Date.now() - start }
      : { label: adapter.label, status: 'error', error: message, latencyMs: Date.now() - start };
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/council/runner.test.ts 2>&1`
Expected: 6 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/core/council/runner.ts tests/council/runner.test.ts
git commit -m "feat(council): add council runner with parallel dispatch and synthesis"
```

---

## Task 6: CLI Entry Point + Dispatch

**Files:**
- Create: `src/cli/council.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write `src/cli/council.ts`**

```typescript
// src/cli/council.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../core/config/loader.ts';
import { parseCouncilConfig } from '../core/council/config.ts';
import { runCouncil } from '../core/council/runner.ts';
import { makeClaudeCouncilAdapter } from '../adapters/council/claude.ts';
import { makeOpenAICouncilAdapter } from '../adapters/council/openai.ts';
import type { CouncilAdapter } from '../adapters/council/types.ts';
import type { CouncilModelEntry } from '../core/council/types.ts';
import { GuardrailError } from '../core/errors.ts';

function makeAdapter(entry: CouncilModelEntry): CouncilAdapter {
  switch (entry.adapter) {
    case 'claude': return makeClaudeCouncilAdapter(entry.model, entry.label);
    case 'openai': return makeOpenAICouncilAdapter(entry.model, entry.label);
  }
}

export async function runCouncilCmd(opts: {
  prompt?: string;
  contextFile?: string;
  configPath?: string;
  dryRun?: boolean;
  noSynthesize?: boolean;
}): Promise<number> {
  const cwd = process.cwd();
  const configPath = opts.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    console.error(err instanceof GuardrailError ? err.message : String(err));
    return 1;
  }

  if (!config.council) {
    console.error('[council] No "council" section in guardrail.config.yaml — add council.models and council.synthesizer');
    return 1;
  }

  let councilConfig;
  try {
    councilConfig = parseCouncilConfig(config.council as Record<string, unknown>);
  } catch (err) {
    console.error(err instanceof GuardrailError ? err.message : String(err));
    return 1;
  }

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify({ schema_version: 1, status: 'dry_run', config: councilConfig }, null, 2) + '\n');
    return 0;
  }

  if (!opts.prompt) {
    console.error('[council] --prompt is required');
    return 1;
  }
  if (!opts.contextFile) {
    console.error('[council] --context-file is required');
    return 1;
  }

  let contextDoc: string;
  try {
    contextDoc = fs.readFileSync(opts.contextFile, 'utf8');
  } catch {
    console.error(`[council] Cannot read context file: ${opts.contextFile}`);
    return 1;
  }

  const adapters = councilConfig.models.map(makeAdapter);
  const synthesizer = opts.noSynthesize
    ? { label: 'none', consult: async () => '' } as CouncilAdapter
    : makeAdapter(councilConfig.synthesizer);

  const result = await runCouncil(
    councilConfig,
    adapters,
    synthesizer,
    opts.prompt,
    contextDoc,
  );

  // When no-synthesize, clear the empty synthesis object
  if (opts.noSynthesize && result.synthesis?.text === '') {
    delete (result as Record<string, unknown>)['synthesis'];
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.status === 'failed') return 2;
  if (result.status === 'partial') return 1;
  return 0;
}
```

- [ ] **Step 2: Add import to `src/cli/index.ts`**

After the existing `import { runTestGen }` line, add:
```typescript
import { runCouncilCmd } from './council.ts';
```

- [ ] **Step 3: Add `'council'` to the SUBCOMMANDS array in `src/cli/index.ts`**

Find the line:
```typescript
const SUBCOMMANDS = ['init', 'run', 'scan', ...
```
Add `'council'` to the array.

- [ ] **Step 4: Add dispatch case to `src/cli/index.ts`**

Before the `default:` case in the `switch (subcommand)` block, add:
```typescript
  case 'council': {
    const config = flag('config');
    const prompt = flag('prompt');
    const contextFile = flag('context-file');
    const dryRun = boolFlag('dry-run');
    const noSynthesize = boolFlag('no-synthesize');
    const code = await runCouncilCmd({
      prompt,
      contextFile,
      configPath: config,
      dryRun,
      noSynthesize,
    });
    process.exit(code);
    break;
  }
```

- [ ] **Step 5: Run all council tests together**

Run: `node --test tests/council/context.test.ts tests/council/config.test.ts tests/council/runner.test.ts 2>&1`
Expected: 15 passing, 0 failing

- [ ] **Step 6: Run full test suite**

Run: `node scripts/test-runner.mjs 2>&1 | tail -10`
Expected: no new failures compared to baseline

- [ ] **Step 7: Commit**

```bash
git add src/cli/council.ts src/cli/index.ts
git commit -m "feat(council): wire guardrail council CLI command"
```

---

## Self-Review

**Spec coverage check:**
- ✅ `guardrail council --prompt --context-file` — Task 6
- ✅ `--dry-run` (print config + exit) — Task 6
- ✅ `--no-synthesize` (Approach A fallback) — Task 6
- ✅ `CouncilAdapter` interface — Task 1
- ✅ `windowContext` (top-truncation, marker, stderr log) — Task 2
- ✅ Config defaults (timeoutMs=30000, minSuccessful=1, budgets) — Task 3
- ✅ Config validation (≥2 models, unique labels, supported adapters, timeout≥5000, quorum bounds) — Task 3
- ✅ `council` in JSON Schema (AJV, not Zod — project uses AJV) — Task 3
- ✅ `council?` field in `GuardrailConfig` — Task 3
- ✅ Claude adapter (`@anthropic-ai/sdk`) — Task 4
- ✅ OpenAI adapter (`openai` chat completions) — Task 4
- ✅ Parallel dispatch with per-model timeout via `Promise.race` — Task 5
- ✅ Quorum check before synthesis — Task 5
- ✅ Synthesis phase with windowed context — Task 5
- ✅ Exit codes 0/1/2 — Task 6
- ✅ JSON to stdout — Task 6
- ✅ `schema_version: 1`, `run_id`, `status`, `responses`, `synthesis` — Task 5/6
- ✅ Tests: context windowing (3 cases) — Task 2
- ✅ Tests: config parsing (6 cases) — Task 3
- ✅ Tests: runner (6 cases: all-succeed, timeout, all-fail, quorum, synth-fail, latency) — Task 5

**Note:** The spec mentions `councilConfigured` on `get_capabilities` (MCP tool). This is an MCP concern handled in the MCP server PR — not in scope for this plan.

**Placeholder scan:** None found.

**Type consistency:**
- `CouncilAdapter.consult(prompt, context)` — called identically in runner tests and runner implementation ✅
- `windowContext(text, maxTokens)` — consistent across context.ts, runner.ts, tests ✅
- `CouncilConfig.timeoutMs` (camelCase) set by `parseCouncilConfig` from yaml `timeout_ms` (snake_case) ✅
- `runCouncil(config, adapters, synthesizer, prompt, contextDoc)` — 5-arg signature used identically in CLI and tests ✅
