# guardrail council — Design

## Goal

Add a `guardrail council` command that sends a prompt + accumulating session document to multiple configured LLM models in parallel, then synthesizes their responses into a single recommendation. Used as mandatory checkpoints during brainstorming (approach selection and design-draft review) and ad-hoc from any brainstorming session.

## Architecture

```
guardrail council --prompt "..." --context-file /tmp/session.md
        │
        ├── src/cli/council.ts          ← entry point, config loading, output formatting
        │
        └── src/core/council/
              ├── runner.ts             ← parallel dispatch, quorum check, synthesis
              ├── context.ts            ← token-budget windowing of session doc
              ├── config.ts             ← Zod schema + validation
              └── types.ts              ← CouncilConfig, CouncilResult, ModelResponse
```

Adapters live under `src/adapters/council/`:

```
src/adapters/council/
  ├── types.ts        ← CouncilAdapter interface
  ├── claude.ts       ← Anthropic SDK wrapper
  └── openai.ts       ← OpenAI SDK wrapper
```

### New files

| File | Responsibility |
|------|----------------|
| `src/cli/council.ts` | Parse args, load config, load adapters, call runner, format output |
| `src/core/council/runner.ts` | Parallel dispatch with per-model timeouts, quorum check, synthesis pass |
| `src/core/council/context.ts` | Truncate session doc to fit `parallelInputMaxTokens` budget |
| `src/core/council/config.ts` | Zod schema; `parseCouncilConfig(raw) → CouncilConfig` |
| `src/core/council/types.ts` | Shared types |
| `src/adapters/council/types.ts` | `CouncilAdapter` interface |
| `src/adapters/council/claude.ts` | Anthropic SDK adapter |
| `src/adapters/council/openai.ts` | OpenAI SDK adapter |

### Modified files

| File | Change |
|------|--------|
| `src/cli/index.ts` | Add `case 'council':` dispatch |
| `src/core/config/types.ts` | Add `council?: CouncilConfigRaw` field to `GuardrailConfig` |

## Configuration

```yaml
# guardrail.config.yaml
council:
  models:
    - adapter: claude
      model: claude-opus-4-7
      label: Claude
    - adapter: openai
      model: gpt-5.4
      label: Codex
  synthesizer:
    adapter: claude
    model: claude-opus-4-7
    label: Claude          # must match one of models[] or be a standalone entry
  timeout_ms: 30000         # per-model timeout (default: 30000)
  min_successful_responses: 1  # quorum floor (default: 1)
  parallel_input_max_tokens: 8000   # session doc budget for parallel phase
  synthesis_input_max_tokens: 12000 # budget for synthesis (doc + all responses)
```

### Validation rules (Zod)
- `models` must have at least 2 entries
- `label` must be unique across `models`
- `synthesizer.label` must be unique (not a duplicate of a models entry)
- `min_successful_responses` ≥ 1 and ≤ `models.length`
- `timeout_ms` ≥ 5000
- Unknown adapter names rejected at parse time

## CouncilAdapter Interface

```typescript
// src/adapters/council/types.ts
export interface CouncilAdapter {
  readonly label: string;
  consult(prompt: string, context: string): Promise<string>;
}
```

The interface is intentionally minimal — general prompt/response, not code-review-specific. Claude and OpenAI adapters wrap their respective SDKs with a system prompt that frames the role ("You are a technical advisor reviewing a software design decision...").

## Execution Flow

```
runner.runCouncil(config, prompt, contextDoc):
  1. windowContext(contextDoc, parallel_input_max_tokens)  → truncated context
  2. Promise.allSettled([
       Promise.race([adapter1.consult(prompt, ctx), timeout(timeout_ms)]),
       Promise.race([adapter2.consult(prompt, ctx), timeout(timeout_ms)]),
       ...
     ])
  3. Collect settled results; classify as fulfilled/rejected/timed-out
  4. Quorum check: fulfilledCount < min_successful_responses → return status:'failed'
  5. windowContext(contextDoc + all fulfilled responses, synthesis_input_max_tokens)
  6. synthesizer.consult(synthesisPrompt, synthesisCtx)  → synthesis text
  7. Return CouncilResult
```

## Context Windowing

`context.ts` truncates the session doc when it exceeds the token budget:

- Token estimate: `Math.ceil(text.length / 4)` (char-based approximation)
- Truncation strategy: drop from the **top** (oldest content first), keep most recent sections
- Add a `<!-- [council: truncated N chars] -->` marker at the cut point
- Log truncation to stderr

## Output Format

`guardrail council` emits JSON to stdout. Markdown rendering is the caller's responsibility.

```typescript
interface CouncilResult {
  schema_version: 1;
  run_id: string;
  status: 'success' | 'partial' | 'failed';
  prompt: string;
  responses: ModelResponse[];
  synthesis?: SynthesisResponse;
}

interface ModelResponse {
  label: string;
  status: 'ok' | 'timeout' | 'error';
  text?: string;
  error?: string;
  latencyMs: number;
}

interface SynthesisResponse {
  label: string;
  text: string;
  latencyMs: number;
}
```

Exit codes:
- `0` — success or partial (≥ `min_successful_responses` succeeded, synthesis completed)
- `1` — synthesis failed (responses collected but synthesizer errored)
- `2` — quorum not met (< `min_successful_responses` succeeded)

## CLI Surface

```bash
# Standard use
guardrail council --prompt "Which approach is better?" --context-file /tmp/session.md

# Dry run (print config + exit)
guardrail council --dry-run

# No synthesis (Approach A fallback mode)
guardrail council --prompt "..." --context-file /tmp/session.md --no-synthesize
```

`--context-file` is required (stdin piping is not supported in initial version).

## Error Handling

- Per-model timeout: counted as `status: 'timeout'` in responses, does not throw
- Adapter auth error: counted as `status: 'error'`, reason in `error` field
- Quorum failure: result returned with `status: 'failed'`, exit code 2
- Synthesis failure: result returned with `status: 'partial'`, exit code 1
- Config validation error: thrown synchronously before any API calls, exit code 1

## Testing

- Unit: `parseCouncilConfig` — valid config, duplicate labels, empty models, synthesizer not in models, bad adapter name
- Unit: `windowContext` — under budget (no-op), over budget (truncation with marker), exactly at budget
- Unit: `runner.runCouncil` with mock adapters — all succeed, partial (1 timeout + 1 success), all fail, quorum failure, synthesis failure
- Integration: mock adapters, full JSON output shape matches `CouncilResult` schema
- Snapshot: `get_capabilities` (already exists) still passes after adding `councilConfigured` field
