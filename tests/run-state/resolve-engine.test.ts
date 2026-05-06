// tests/run-state/resolve-engine.test.ts
//
// v6.0.1 Part A — exhaustive coverage for resolveEngineEnabled, the pure
// precedence resolver. Spec: docs/specs/v6-run-state-engine.md "Migration
// path (v5.6 → v6) + precedence matrix".
//
// Precedence (highest wins): CLI flag > env > config > built-in default.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_DEFAULT_V6_0,
  parseEngineEnvValue,
  resolveEngineEnabled,
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
  it('defaults to false (v6.0) when nothing is set', () => {
    const r = resolveEngineEnabled();
    assert.equal(r.enabled, false);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /built-in default/);
    assert.equal(r.invalidEnvValue, undefined);
  });

  it('exposes ENGINE_DEFAULT_V6_0 = false for clarity', () => {
    assert.equal(ENGINE_DEFAULT_V6_0, false);
  });

  it('honors a provided builtInDefault override (forward-compat for v6.1 flip)', () => {
    const r = resolveEngineEnabled({ builtInDefault: true });
    assert.equal(r.enabled, true);
    assert.equal(r.source, 'default');
    assert.match(r.reason, /engine on/);
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

  it('invalid env value falls through to built-in default when no config', () => {
    const r = resolveEngineEnabled({ envValue: 'definitely-not' });
    assert.equal(r.enabled, false);
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
    // Nothing → default
    { want: false, src: 'default' },
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
