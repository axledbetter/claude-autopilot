import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { GUARDRAIL_CONFIG_SCHEMA } from '../src/core/config/schema.ts';

const ajv = new Ajv();
const validate = ajv.compile(GUARDRAIL_CONFIG_SCHEMA);

describe('brand config schema', () => {
  it('accepts brand block with colors and fonts', () => {
    const valid = validate({
      configVersion: 1,
      brand: {
        colors: ['#f97316', '#1a1f3a'],
        fonts: ['Inter'],
      },
    });
    assert.ok(valid, JSON.stringify(validate.errors));
  });

  it('accepts brand block with colorsFrom', () => {
    const valid = validate({
      configVersion: 1,
      brand: { colorsFrom: 'tailwind.config.ts' },
    });
    assert.ok(valid, JSON.stringify(validate.errors));
  });

  it('accepts brand block with componentLibrary', () => {
    const valid = validate({
      configVersion: 1,
      brand: { componentLibrary: 'app/components/ui/' },
    });
    assert.ok(valid, JSON.stringify(validate.errors));
  });

  it('rejects unknown brand fields', () => {
    const valid = validate({
      configVersion: 1,
      brand: { unknownField: true },
    });
    assert.equal(valid, false);
  });
});
