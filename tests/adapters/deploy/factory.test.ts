// tests/adapters/deploy/factory.test.ts
//
// Phase 5 of v5.6 — factory polish. The per-adapter required-fields
// validation already lives in `src/adapters/deploy/index.ts` and is
// covered piecemeal across `tests/deploy-config-schema.test.ts`,
// `tests/adapters/deploy/fly.test.ts`, and `tests/adapters/deploy/render.test.ts`.
//
// This file is the single parameterized regression that asserts every
// adapter type throws `invalid_config` with a *field-named* message
// (mentioning the missing config key by name) when its required input
// is absent. The intent is to catch any future regression where a new
// adapter slips a generic "missing config" message into the factory.
//
// Spec: docs/specs/v5.6-fly-render-adapters.md § "Implementation phases"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDeployAdapter } from '../../../src/adapters/deploy/index.ts';
import { GuardrailError } from '../../../src/core/errors.ts';
import type { DeployConfig } from '../../../src/adapters/deploy/types.ts';

interface FactoryCase {
  /** Human-readable label used by the test runner. */
  name: string;
  /** Config that omits the required field this case is about. */
  config: DeployConfig;
  /** Provider tag we expect on the thrown GuardrailError. */
  provider: string;
  /** Substring of the error message that names the missing field. */
  fieldNamed: RegExp;
}

const CASES: readonly FactoryCase[] = [
  {
    name: 'vercel without project',
    config: { adapter: 'vercel' } as DeployConfig,
    provider: 'vercel',
    fieldNamed: /deploy\.project/,
  },
  {
    name: 'fly without app',
    config: { adapter: 'fly', image: 'registry.fly.io/my-app:latest' } as DeployConfig,
    provider: 'fly',
    fieldNamed: /deploy\.app/,
  },
  {
    name: 'fly without image',
    config: { adapter: 'fly', app: 'my-app' } as DeployConfig,
    provider: 'fly',
    fieldNamed: /deploy\.image/,
  },
  {
    name: 'render without serviceId',
    config: { adapter: 'render' } as DeployConfig,
    provider: 'render',
    fieldNamed: /deploy\.serviceId/,
  },
  {
    name: 'generic without deployCommand',
    config: { adapter: 'generic' } as DeployConfig,
    provider: 'generic',
    fieldNamed: /deploy\.deployCommand/,
  },
];

describe('createDeployAdapter — required-fields validation (parameterized)', () => {
  for (const c of CASES) {
    it(`throws invalid_config with field-named message for ${c.name}`, () => {
      assert.throws(
        () => createDeployAdapter(c.config),
        (err: unknown) => {
          if (!(err instanceof GuardrailError)) {
            assert.fail(`expected GuardrailError, got ${err instanceof Error ? err.constructor.name : typeof err}`);
          }
          assert.equal(err.code, 'invalid_config', `wrong code for ${c.name}`);
          assert.equal(err.provider, c.provider, `wrong provider for ${c.name}`);
          assert.match(err.message, c.fieldNamed, `message did not name the missing field for ${c.name}: ${err.message}`);
          return true;
        },
      );
    });
  }
});
