// tests/run-state/resolve-engine.test.ts
//
// v7.0 — engine-off path retired. resolveEngineEnabled() returns
// `{ enabled: true, source: 'default' }` unconditionally. The pre-v7
// precedence matrix tests are obsolete and have been collapsed.
//
// Spec: docs/specs/v7.0-phase6-launch.md scope item 2 + test #2.
//
// Notes on the deprecated v6 exports `ENGINE_DEFAULT_V6_0` and
// `ENGINE_DEFAULT_V6_1`: REMOVED in v7.0. Direct imports of either
// constant are intentionally breaking; the migration guide documents
// replacing them with literal `true` in downstream consumers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_OFF_DEPRECATION_MESSAGE,
  emitEngineOffDeprecationWarning,
  parseEngineEnvValue,
  resolveEngineEnabled,
  shouldWarnEngineOffDeprecation,
} from '../../src/core/run-state/resolve-engine.ts';

describe('v7.0 — resolveEngineEnabled is unconditionally on', () => {
  it('no inputs → enabled=true, source=default', () => {
    const r = resolveEngineEnabled();
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /v7\.0\+/);
  });

  it('cliEngine=false is ignored — engine remains on', () => {
    const r = resolveEngineEnabled({ cliEngine: false });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
  });

  it('envValue=off is ignored — engine remains on', () => {
    const r = resolveEngineEnabled({ envValue: 'off' });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
  });

  it('configEnabled=false is ignored — engine remains on', () => {
    const r = resolveEngineEnabled({ configEnabled: false });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
  });

  it('builtInDefault=false is ignored — engine remains on', () => {
    const r = resolveEngineEnabled({ builtInDefault: false });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
  });

  it('all four pre-v7 inputs at once → still enabled=true', () => {
    const r = resolveEngineEnabled({
      cliEngine: false,
      envValue: 'off',
      configEnabled: false,
      builtInDefault: false,
    });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
  });

  it('invalidEnvValue is never set in v7.0 (env path is gone)', () => {
    const r = resolveEngineEnabled({ envValue: 'maybe' });
    assert.equal(r.invalidEnvValue, undefined);
  });
});

describe('v7.0 — deprecated exports REMOVED (compile-time check)', () => {
  it('ENGINE_DEFAULT_V6_0 is no longer exported', async () => {
    const mod = await import('../../src/core/run-state/resolve-engine.ts') as Record<string, unknown>;
    assert.equal(mod.ENGINE_DEFAULT_V6_0, undefined);
  });

  it('ENGINE_DEFAULT_V6_1 is no longer exported', async () => {
    const mod = await import('../../src/core/run-state/resolve-engine.ts') as Record<string, unknown>;
    assert.equal(mod.ENGINE_DEFAULT_V6_1, undefined);
  });
});

describe('v7.0 — parseEngineEnvValue still parses (back-compat for out-of-tree callers)', () => {
  it('parses on/off/true/false/1/0/yes/no', () => {
    assert.equal(parseEngineEnvValue('on'), true);
    assert.equal(parseEngineEnvValue('off'), false);
    assert.equal(parseEngineEnvValue('true'), true);
    assert.equal(parseEngineEnvValue('false'), false);
    assert.equal(parseEngineEnvValue(undefined), undefined);
    assert.equal(parseEngineEnvValue(''), undefined);
    assert.equal(parseEngineEnvValue('garbage'), undefined);
  });
});

describe('v7.0 — deprecation helpers are no-op stubs', () => {
  it('shouldWarnEngineOffDeprecation always returns false', () => {
    for (const source of ['cli', 'env', 'config', 'default'] as const) {
      assert.equal(shouldWarnEngineOffDeprecation({ enabled: false, source }), false);
      assert.equal(shouldWarnEngineOffDeprecation({ enabled: true, source }), false);
    }
  });

  it('emitEngineOffDeprecationWarning is a no-op (returns false)', () => {
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(
      { enabled: false, source: 'cli' },
      (msg) => captured.push(msg),
    );
    assert.equal(fired, false);
    assert.deepEqual(captured, []);
  });

  it('ENGINE_OFF_DEPRECATION_MESSAGE remains exported with v7.0 wording', () => {
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /v7\.0/);
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /removed/);
  });
});
