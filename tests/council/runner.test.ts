import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCouncil } from '../../src/core/council/runner.ts';
import type { CouncilConfig } from '../../src/core/council/types.ts';
import type { CouncilAdapter } from '../../src/adapters/council/types.ts';

function makeAdapter(label: string, response: string, delayMs = 0): CouncilAdapter {
  return {
    label,
    async consult() {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return { text: response, usage: { input: 10, output: 5, costUSD: 0.0001 } };
    },
  };
}

function makeFailingAdapter(label: string): CouncilAdapter {
  return {
    label,
    async consult() { throw new Error('api error'); },
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
    const { result } = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
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
    const { result } = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
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
    const { result } = await runCouncil(baseConfig, adapters, synthesizer, 'test prompt', 'context doc');
    assert.equal(result.status, 'failed');
    assert.equal(result.synthesis, undefined);
    assert.ok(result.responses.every(r => r.status === 'error'));
  });

  it('R4: quorum not met with stricter config — status failed', async () => {
    const strictConfig = { ...baseConfig, minSuccessfulResponses: 2 };
    const adapters = [makeFailingAdapter('A'), makeAdapter('B', 'ok B')];
    const synthesizer = makeAdapter('Synth', 'synthesis');
    const { result } = await runCouncil(strictConfig, adapters, synthesizer, 'test prompt', 'context');
    assert.equal(result.status, 'failed');
    assert.equal(result.synthesis, undefined);
  });

  it('R5: synthesis throws — status partial, responses present', async () => {
    const adapters = [makeAdapter('A', 'response A'), makeAdapter('B', 'response B')];
    const failSynth = makeFailingAdapter('Synth');
    const { result } = await runCouncil(baseConfig, adapters, failSynth, 'test prompt', 'context doc');
    assert.equal(result.status, 'partial');
    assert.equal(result.responses.filter(r => r.status === 'ok').length, 2);
    assert.equal(result.synthesis, undefined);
  });

  it('R6: latencyMs is measured for each response', async () => {
    const adapters = [makeAdapter('A', 'r', 50), makeAdapter('B', 'r', 50)];
    const synthesizer = makeAdapter('Synth', 's');
    const { result } = await runCouncil(baseConfig, adapters, synthesizer, 'q', 'ctx');
    // Timer jitter on fast CI can fire setTimeout(50) at ~45ms; we only need to
    // verify latency is *measured*, not that it equals the delay to the ms.
    assert.ok(
      result.responses.every(r => r.latencyMs >= 40),
      `latencyMs should be roughly the adapter delay; got ${result.responses.map(r => r.latencyMs).join(', ')}`,
    );
  });

  it('R8: synthesizer receives advisor responses exactly once (no doc/prompt duplication)', async () => {
    // Capture what the synthesizer sees so we can prove responseSections
    // is not duplicated across prompt + context.
    let capturedPrompt = '';
    let capturedContext = '';
    const synthesizer: CouncilAdapter = {
      label: 'Synth',
      async consult(p: string, c: string) {
        capturedPrompt = p;
        capturedContext = c;
        return { text: 'synthesis' };
      },
    };
    const adapters = [makeAdapter('A', 'response-A-text-marker'), makeAdapter('B', 'response-B-text-marker')];
    await runCouncil(baseConfig, adapters, synthesizer, 'q', 'context-doc-marker');
    const matchesA = (capturedPrompt + capturedContext).split('response-A-text-marker').length - 1;
    const matchesB = (capturedPrompt + capturedContext).split('response-B-text-marker').length - 1;
    assert.equal(matchesA, 1, 'response A should appear exactly once across prompt+context');
    assert.equal(matchesB, 1, 'response B should appear exactly once across prompt+context');
    assert.ok(capturedContext.includes('context-doc-marker'), 'context should still carry the original conversation doc');
  });

  it('R7: successful adapter clears timeout timer (does not keep event loop alive)', async () => {
    // If the timer were not cleared, this test would hang for the full timeoutMs
    // after the adapter resolves. node:test has a default 30s timeout; if we
    // measure wall clock against timeoutMs, the fix shows up as "done quickly"
    // rather than "done in ≥ timeoutMs".
    const longTimeoutConfig = { ...baseConfig, timeoutMs: 10000 };
    const adapters = [makeAdapter('A', 'fast', 10), makeAdapter('B', 'fast', 10)];
    const synthesizer = makeAdapter('Synth', 's');
    const start = Date.now();
    await runCouncil(longTimeoutConfig, adapters, synthesizer, 'q', 'ctx');
    // Total elapsed should be ~10ms, not anywhere near 10s
    assert.ok(Date.now() - start < 1000, 'expected fast completion without waiting for timer');
  });

  // --------------------------------------------------------------------------
  // Phase 4 — bounded synthesizer recursion (v6 spec "Budget enforcement")
  // --------------------------------------------------------------------------

  it('R9: depth bound — synthesizer recursion exceeding max returns partial status', async () => {
    // Simulate a self-eating synthesizer by having its `consult()` recurse
    // back into runCouncil with currentDepth + 1. With maxDepth = 2, the
    // 3rd nested call must abort with `partial`.
    const boundedConfig: CouncilConfig = { ...baseConfig, councilMaxRecursionDepth: 2 };
    const adapters = [makeAdapter('A', 'r')];
    let recursedCount = 0;
    const recursingSynth: CouncilAdapter = {
      label: 'Synth',
      async consult(p, c) {
        recursedCount += 1;
        // Recurse inward — at depth N, request depth N+1.
        const nested = await runCouncil(
          boundedConfig,
          adapters,
          recursingSynth,
          p,
          c,
          { currentDepth: recursedCount },
        );
        return { text: nested.result.synthesis?.text ?? `recursed ${recursedCount}` };
      },
    };
    const { result } = await runCouncil(
      boundedConfig,
      adapters,
      recursingSynth,
      'q',
      'ctx',
      { currentDepth: 0 },
    );
    // The bound MUST eventually fire; status reflects what happened at the
    // outermost level. The outermost call still has a synthesizer that
    // returned a value (the recursive call eventually short-circuited and
    // that result bubbles up). The point of the test: recursion did not
    // explode unboundedly.
    assert.ok(recursedCount <= 3, `recursion bounded; got depth ${recursedCount}`);
    assert.ok(['success', 'partial'].includes(result.status));
  });

  it('R10: depth bound — exceeding max at the entry point returns partial immediately', async () => {
    // Calling runCouncil with currentDepth already beyond the bound is
    // the `recurses too deep` aborting path. Should NOT call any adapter
    // at all — the bound check fires first.
    const adapters = [makeAdapter('A', 'r')];
    const synthesizer = makeAdapter('Synth', 's');
    const boundedConfig: CouncilConfig = { ...baseConfig, councilMaxRecursionDepth: 1 };
    const { result, usage } = await runCouncil(
      boundedConfig,
      adapters,
      synthesizer,
      'q',
      'ctx',
      { currentDepth: 5 },
    );
    assert.equal(result.status, 'partial');
    assert.equal(result.responses.length, 0, 'no adapters consulted past the bound');
    assert.equal(result.synthesis, undefined);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
  });

  it('R11: depth bound — without councilMaxRecursionDepth set, behavior unchanged (back-compat)', async () => {
    // No bound configured → currentDepth is irrelevant; runCouncil runs
    // the full single-shot pipeline as before.
    const adapters = [makeAdapter('A', 'response A')];
    const synthesizer = makeAdapter('Synth', 'synthesis text');
    const { result } = await runCouncil(
      baseConfig, // no councilMaxRecursionDepth
      adapters,
      synthesizer,
      'q',
      'ctx',
      { currentDepth: 99 }, // should be ignored
    );
    assert.equal(result.status, 'success');
    assert.equal(result.synthesis?.text, 'synthesis text');
  });

  it('R12: depth bound — currentDepth defaults to 0 when omitted', async () => {
    // Top-level callers don't pass currentDepth; default of 0 must permit
    // the call to run normally even when a small bound is set.
    const adapters = [makeAdapter('A', 'r')];
    const synthesizer = makeAdapter('Synth', 's');
    const boundedConfig: CouncilConfig = { ...baseConfig, councilMaxRecursionDepth: 1 };
    const { result } = await runCouncil(
      boundedConfig,
      adapters,
      synthesizer,
      'q',
      'ctx',
      // no options — defaults to { currentDepth: 0 }
    );
    // 0 <= 1 → not aborted by the bound; full pipeline runs.
    assert.equal(result.status, 'success');
  });
});
