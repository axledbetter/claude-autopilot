// tests/run-state/resolve-engine.test.ts
//
// v6.0.1 Part A — exhaustive coverage for resolveEngineEnabled, the pure
// precedence resolver. Spec: docs/specs/v6-run-state-engine.md "Migration
// path (v5.6 → v6) + precedence matrix".
//
// v6.1 update — default flipped from `false` → `true`. The default-related
// cases below have been pinned to the v6.1 behavior. The bottom of the file
// adds a dedicated `v6.1 default-flip` describe block plus deprecation-warning
// coverage for `--no-engine` / `engine.enabled: false` / `CLAUDE_AUTOPILOT_ENGINE=off`.
//
// Precedence (highest wins): CLI flag > env > config > built-in default.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_DEFAULT_V6_0,
  ENGINE_DEFAULT_V6_1,
  ENGINE_OFF_DEPRECATION_MESSAGE,
  emitEngineOffDeprecationWarning,
  parseEngineEnvValue,
  resolveEngineEnabled,
  shouldWarnEngineOffDeprecation,
} from '../../src/core/run-state/resolve-engine.ts';

// ---------------------------------------------------------------------------
// parseEngineEnvValue — accepts on/off/true/false/1/0/yes/no, case-insensitive
// ---------------------------------------------------------------------------

describe('parseEngineEnvValue — accepted forms', () => {
  const truthy = ['on', 'true', '1', 'yes', 'ON', 'True', 'YES', ' on ', 'TRUE\n'];
  const falsy = ['off', 'false', '0', 'no', 'OFF', 'False', 'NO', ' off ', 'FALSE\n'];

  for (const raw of truthy) {
    it(`parses ${JSON.stringify(raw)} as true`, () => {
      assert.equal(parseEngineEnvValue(raw), true);
    });
  }
  for (const raw of falsy) {
    it(`parses ${JSON.stringify(raw)} as false`, () => {
      assert.equal(parseEngineEnvValue(raw), false);
    });
  }

  it('returns undefined for unset / empty / whitespace', () => {
    assert.equal(parseEngineEnvValue(undefined), undefined);
    assert.equal(parseEngineEnvValue(''), undefined);
    assert.equal(parseEngineEnvValue('   '), undefined);
    assert.equal(parseEngineEnvValue('\t\n'), undefined);
  });

  it('returns undefined for malformed values', () => {
    assert.equal(parseEngineEnvValue('maybe'), undefined);
    assert.equal(parseEngineEnvValue('2'), undefined);
    assert.equal(parseEngineEnvValue('-1'), undefined);
    assert.equal(parseEngineEnvValue('y'), undefined); // we require full word
    assert.equal(parseEngineEnvValue('n'), undefined);
    assert.equal(parseEngineEnvValue('enable'), undefined);
    assert.equal(parseEngineEnvValue('disable'), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveEngineEnabled — precedence matrix
// ---------------------------------------------------------------------------

describe('resolveEngineEnabled — built-in default (no inputs)', () => {
  it('defaults to true (v6.1+) when nothing is set', () => {
    const r = resolveEngineEnabled();
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /built-in default/);
    assert.match(r.reason, /engine on/);
    assert.equal(r.invalidEnvValue, undefined);
  });

  it('exposes ENGINE_DEFAULT_V6_1 = true for clarity', () => {
    assert.equal(ENGINE_DEFAULT_V6_1, true);
  });

  it('preserves the deprecated ENGINE_DEFAULT_V6_0 with its historical value (false)', () => {
    // The v6.0 export name is kept for any out-of-tree consumer that
    // imported it; v7 will drop it. The constant's semantic meaning —
    // "v6.0 default was off" — does NOT change just because v6.1 flipped
    // the active default. Consumers who pinned this symbol get the value
    // the name promises (false), not the new active default.
    assert.equal(ENGINE_DEFAULT_V6_0, false);
    assert.notEqual(ENGINE_DEFAULT_V6_0, ENGINE_DEFAULT_V6_1);
  });

  it('honors a provided builtInDefault: false override (back-compat for explicit pinning)', () => {
    const r = resolveEngineEnabled({ builtInDefault: false });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /engine off/);
  });
});

describe('resolveEngineEnabled — config layer', () => {
  it('config: true wins over built-in default', () => {
    const r = resolveEngineEnabled({ configEnabled: true });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'config');
    assert.match(r.reason, /engine\.enabled: true/);
  });

  it('config: false wins over built-in default true (forward-compat)', () => {
    const r = resolveEngineEnabled({ configEnabled: false, builtInDefault: true });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'config');
    assert.match(r.reason, /engine\.enabled: false/);
  });
});

describe('resolveEngineEnabled — env layer', () => {
  it('env on overrides config off', () => {
    const r = resolveEngineEnabled({ envValue: 'on', configEnabled: false });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'env');
    assert.match(r.reason, /CLAUDE_AUTOPILOT_ENGINE=on/);
  });

  it('env off overrides config on', () => {
    const r = resolveEngineEnabled({ envValue: 'off', configEnabled: true });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'env');
    assert.match(r.reason, /CLAUDE_AUTOPILOT_ENGINE=off/);
  });

  it('every accepted env form decides at the env layer', () => {
    const cases: Array<[string, boolean]> = [
      ['on', true], ['off', false],
      ['true', true], ['false', false],
      ['1', true], ['0', false],
      ['yes', true], ['no', false],
      ['ON', true], ['OFF', false],
      ['Yes', true], ['No', false],
    ];
    for (const [raw, want] of cases) {
      const r = resolveEngineEnabled({ envValue: raw });
      assert.equal(r.enabled, want, `env=${raw}`);
      assert.equal(r.source, 'env', `env=${raw}`);
    }
  });

  it('invalid env value falls through to config and records invalidEnvValue', () => {
    const r = resolveEngineEnabled({ envValue: 'maybe', configEnabled: true });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'config');
    assert.equal(r.invalidEnvValue, 'maybe');
    assert.match(r.reason, /invalid CLAUDE_AUTOPILOT_ENGINE/);
  });

  it('invalid env value falls through to built-in default (v6.1: on) when no config', () => {
    const r = resolveEngineEnabled({ envValue: 'definitely-not' });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.equal(r.invalidEnvValue, 'definitely-not');
    assert.match(r.reason, /invalid CLAUDE_AUTOPILOT_ENGINE/);
  });

  it('invalid env value with config: false stays false at config layer', () => {
    const r = resolveEngineEnabled({ envValue: '???', configEnabled: false });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'config');
    assert.equal(r.invalidEnvValue, '???');
  });

  it('empty env string is treated as unset (no invalid marker)', () => {
    const r = resolveEngineEnabled({ envValue: '', configEnabled: true });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'config');
    assert.equal(r.invalidEnvValue, undefined);
  });

  it('whitespace-only env string is treated as unset (no invalid marker)', () => {
    const r = resolveEngineEnabled({ envValue: '   ', builtInDefault: true });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.equal(r.invalidEnvValue, undefined);
  });
});

describe('resolveEngineEnabled — CLI layer (highest precedence)', () => {
  it('--engine wins over env off + config off', () => {
    const r = resolveEngineEnabled({
      cliEngine: true,
      envValue: 'off',
      configEnabled: false,
    });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'cli');
    assert.match(r.reason, /--engine/);
  });

  it('--no-engine wins over env on + config on', () => {
    const r = resolveEngineEnabled({
      cliEngine: false,
      envValue: 'on',
      configEnabled: true,
    });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'cli');
    assert.match(r.reason, /--no-engine/);
  });

  it('--engine wins even when builtInDefault is true', () => {
    const r = resolveEngineEnabled({
      cliEngine: true,
      builtInDefault: true,
    });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'cli');
  });

  it('--no-engine wins even when builtInDefault is true', () => {
    const r = resolveEngineEnabled({
      cliEngine: false,
      builtInDefault: true,
    });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'cli');
  });

  it('--engine never carries invalidEnvValue (env is bypassed entirely)', () => {
    const r = resolveEngineEnabled({
      cliEngine: true,
      envValue: 'garbage',
      configEnabled: false,
    });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'cli');
    assert.equal(r.invalidEnvValue, undefined);
  });
});

// ---------------------------------------------------------------------------
// Full precedence sweep — every meaningful combination of layers.
// ---------------------------------------------------------------------------

describe('resolveEngineEnabled — full precedence sweep', () => {
  type Cell = { cli?: boolean; env?: string; cfg?: boolean; want: boolean; src: 'cli' | 'env' | 'config' | 'default' };
  const cells: Cell[] = [
    // CLI on top
    { cli: true,  env: 'off', cfg: false, want: true,  src: 'cli' },
    { cli: false, env: 'on',  cfg: true,  want: false, src: 'cli' },
    // CLI absent → env decides
    { env: 'on',  cfg: false, want: true,  src: 'env' },
    { env: 'off', cfg: true,  want: false, src: 'env' },
    // CLI absent + env unset → config decides
    { cfg: true,  want: true,  src: 'config' },
    { cfg: false, want: false, src: 'config' },
    // Nothing → default (v6.1+: ON)
    { want: true, src: 'default' },
  ];
  for (const c of cells) {
    const label = `cli=${c.cli ?? 'unset'} env=${c.env ?? 'unset'} cfg=${c.cfg ?? 'unset'} → ${c.want} (${c.src})`;
    it(label, () => {
      const r = resolveEngineEnabled({
        ...(c.cli !== undefined ? { cliEngine: c.cli } : {}),
        ...(c.env !== undefined ? { envValue: c.env } : {}),
        ...(c.cfg !== undefined ? { configEnabled: c.cfg } : {}),
      });
      assert.equal(r.enabled, c.want, label);
      assert.equal(r.source, c.src, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Note on conflicting --engine + --no-engine: that's a CLI-layer error
// detected and rejected by the dispatcher BEFORE this function is called.
// resolveEngineEnabled accepts cliEngine: boolean | undefined so the
// dispatcher can narrow the type before passing it in. This is a design
// invariant — there's no "both flags set" case to test here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v6.1 default-flip — pinned behavior for the default = ON era.
// Spec: docs/specs/v6.1-default-flip.md
// ---------------------------------------------------------------------------

describe('v6.1 default-flip — engine ON by default', () => {
  it('built-in default is true (engine on)', () => {
    assert.equal(ENGINE_DEFAULT_V6_1, true);
  });

  it('no inputs → enabled=true, source=default, reason mentions v6.1+', () => {
    const r = resolveEngineEnabled();
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /v6\.1\+/);
    assert.match(r.reason, /engine on/);
  });

  it('explicit engine.enabled: false in config still wins over the new default', () => {
    // Existing v6.0 users who pinned engine off are NOT impacted by the flip.
    const r = resolveEngineEnabled({ configEnabled: false });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'config');
  });

  it('--no-engine still wins over the new default', () => {
    const r = resolveEngineEnabled({ cliEngine: false });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'cli');
  });

  it('CLAUDE_AUTOPILOT_ENGINE=off still wins over the new default', () => {
    const r = resolveEngineEnabled({ envValue: 'off' });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'env');
  });
});

// ---------------------------------------------------------------------------
// v6.1 deprecation warning — fires only when the user explicitly opts out.
// ---------------------------------------------------------------------------

describe('v6.1 deprecation warning — --no-engine / engine.enabled: false', () => {
  it('exports a stable deprecation message string', () => {
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /\[deprecation]/);
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /--no-engine/);
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /engine\.enabled: false/);
    assert.match(ENGINE_OFF_DEPRECATION_MESSAGE, /v7/);
  });

  it('shouldWarn returns true for explicit CLI opt-out', () => {
    assert.equal(shouldWarnEngineOffDeprecation({ enabled: false, source: 'cli' }), true);
  });

  it('shouldWarn returns true for explicit env opt-out', () => {
    assert.equal(shouldWarnEngineOffDeprecation({ enabled: false, source: 'env' }), true);
  });

  it('shouldWarn returns true for explicit config opt-out', () => {
    assert.equal(shouldWarnEngineOffDeprecation({ enabled: false, source: 'config' }), true);
  });

  it('shouldWarn returns false on the v6.1 default (which is enabled=true anyway)', () => {
    assert.equal(shouldWarnEngineOffDeprecation({ enabled: true, source: 'default' }), false);
  });

  it('shouldWarn returns false whenever the engine is on (no opt-out)', () => {
    for (const source of ['cli', 'env', 'config', 'default'] as const) {
      assert.equal(
        shouldWarnEngineOffDeprecation({ enabled: true, source }),
        false,
        `engine on / source=${source}`,
      );
    }
  });

  it('shouldWarn returns false on a forced builtInDefault=false override (not a user opt-out)', () => {
    // Custom builtInDefault → source='default'. Even though enabled=false,
    // there's no user-facing flag/env/config to deprecate, so we don't warn.
    assert.equal(shouldWarnEngineOffDeprecation({ enabled: false, source: 'default' }), false);
  });

  it('emit fires the warner exactly once when the user opts out via CLI', () => {
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(
      { enabled: false, source: 'cli' },
      (msg) => captured.push(msg),
    );
    assert.equal(fired, true);
    assert.deepEqual(captured, [ENGINE_OFF_DEPRECATION_MESSAGE]);
  });

  it('emit fires for env opt-out', () => {
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(
      { enabled: false, source: 'env' },
      (msg) => captured.push(msg),
    );
    assert.equal(fired, true);
    assert.deepEqual(captured, [ENGINE_OFF_DEPRECATION_MESSAGE]);
  });

  it('emit fires for config opt-out', () => {
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(
      { enabled: false, source: 'config' },
      (msg) => captured.push(msg),
    );
    assert.equal(fired, true);
    assert.deepEqual(captured, [ENGINE_OFF_DEPRECATION_MESSAGE]);
  });

  it('emit is a no-op when the engine is on (no opt-out)', () => {
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(
      { enabled: true, source: 'default' },
      (msg) => captured.push(msg),
    );
    assert.equal(fired, false);
    assert.deepEqual(captured, []);
  });

  it('emit is a no-op on the v6.1 default (which is engine-on; enabled=true)', () => {
    // The v6.1 default produces { enabled: true, source: 'default' }, so the
    // resolver result of an unconfigured invocation never trips the warner.
    const r = resolveEngineEnabled();
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(r, (msg) => captured.push(msg));
    assert.equal(fired, false);
    assert.deepEqual(captured, []);
  });

  it('emit defaults to writing to process.stderr when no warner is supplied', () => {
    // Capture stderr.write while the helper runs. The default branch
    // exists for production callers who don't care about testability.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const fired = emitEngineOffDeprecationWarning({ enabled: false, source: 'cli' });
      assert.equal(fired, true);
      assert.equal(writes.length, 1);
      assert.equal(writes[0], `${ENGINE_OFF_DEPRECATION_MESSAGE}\n`);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('emit is a no-op on a builtInDefault=false override (not a user-driven opt-out)', () => {
    // Custom builtInDefault → resolver returns source='default'. We do NOT
    // warn — the predicate's contract says only CLI/env/config-driven
    // opt-outs trigger the deprecation message.
    const r = resolveEngineEnabled({ builtInDefault: false });
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'default');
    const captured: string[] = [];
    const fired = emitEngineOffDeprecationWarning(r, (msg) => captured.push(msg));
    assert.equal(fired, false);
    assert.deepEqual(captured, []);
  });
});
