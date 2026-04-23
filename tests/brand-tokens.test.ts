import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GUARDRAIL_CONFIG_SCHEMA } from '../src/core/config/schema.ts';
import { extractTailwindColors } from '../src/core/static-rules/tailwind-extractor.ts';

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

describe('extractTailwindColors', () => {
  it('returns empty array when file does not exist', () => {
    const colors = extractTailwindColors('/nonexistent/tailwind.config.ts');
    assert.deepEqual(colors, []);
  });

  it('extracts hex colors from a JS object export', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
    const cfgPath = path.join(dir, 'tailwind.config.js');
    fs.writeFileSync(cfgPath, [
      'module.exports = {',
      '  theme: {',
      '    colors: {',
      "      primary: '#f97316',",
      "      background: '#1a1f3a',",
      "      white: '#ffffff',",
      '    },',
      '  },',
      '};',
    ].join('\n'));
    const colors = extractTailwindColors(cfgPath);
    assert.ok(colors.includes('#f97316'), `expected #f97316 in ${JSON.stringify(colors)}`);
    assert.ok(colors.includes('#1a1f3a'));
    assert.ok(colors.includes('#ffffff'));
    fs.rmSync(dir, { recursive: true });
  });

  it('extracts colors from theme.extend.colors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
    const cfgPath = path.join(dir, 'tailwind.config.js');
    fs.writeFileSync(cfgPath, [
      'module.exports = {',
      '  theme: {',
      '    extend: {',
      '      colors: {',
      "        brand: '#abcdef',",
      '      },',
      '    },',
      '  },',
      '};',
    ].join('\n'));
    const colors = extractTailwindColors(cfgPath);
    assert.ok(colors.includes('#abcdef'));
    fs.rmSync(dir, { recursive: true });
  });

  it('deduplicates repeated color values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
    const cfgPath = path.join(dir, 'tailwind.config.js');
    fs.writeFileSync(cfgPath, [
      'module.exports = {',
      '  theme: {',
      "    colors: { a: '#ffffff', b: '#ffffff' },",
      "    extend: { colors: { c: '#ffffff' } },",
      '  },',
      '};',
    ].join('\n'));
    const colors = extractTailwindColors(cfgPath);
    assert.equal(colors.filter(c => c === '#ffffff').length, 1);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty array on parse error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
    const cfgPath = path.join(dir, 'tailwind.config.js');
    fs.writeFileSync(cfgPath, 'THIS IS NOT VALID');
    const colors = extractTailwindColors(cfgPath);
    assert.deepEqual(colors, []);
    fs.rmSync(dir, { recursive: true });
  });
});
