import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GUARDRAIL_CONFIG_SCHEMA } from '../src/core/config/schema.ts';
import { extractTailwindColors } from '../src/core/static-rules/tailwind-extractor.ts';
import { brandTokensRule } from '../src/core/static-rules/rules/brand-tokens.ts';
import { listAvailableRules } from '../src/core/static-rules/registry.ts';

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

function makeTmpFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('brand-tokens rule', () => {
  it('returns no findings when brand config absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Button.tsx', "export const Button = () => <button style={{ color: '#ff0000' }}>click</button>;");
    const findings = await brandTokensRule.check([f], {});
    assert.equal(findings.length, 0, 'no brand config = rule is a no-op');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns no findings when file has no color values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Button.tsx', '<button className="bg-primary">click</button>');
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes hex value that is in the palette', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Button.tsx', "const s = { color: '#f97316' };");
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('flags hex value not in the palette', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Button.tsx', "const s = { color: '#ff0000' };");
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.category, 'brand-tokens');
    assert.ok(findings[0]!.message.includes('#ff0000'));
    fs.rmSync(dir, { recursive: true });
  });

  it('flags arbitrary Tailwind color class not in palette', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Card.tsx', '<div className="bg-[#badbad] text-white">');
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#ffffff'] } });
    assert.equal(findings.length, 1);
    assert.ok(findings[0]!.message.includes('#badbad'));
    fs.rmSync(dir, { recursive: true });
  });

  it('passes arbitrary Tailwind color class that is in palette', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/Card.tsx', '<div className="bg-[#f97316]">');
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('flags off-brand font-family in CSS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/styles.css', "body { font-family: 'Comic Sans MS', cursive; }");
    const findings = await brandTokensRule.check([f], { brand: { fonts: ['Inter', 'Geist'] } });
    assert.equal(findings.length, 1);
    assert.ok(findings[0]!.message.toLowerCase().includes('font'));
    fs.rmSync(dir, { recursive: true });
  });

  it('passes font-family that is in canonical fonts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/styles.css', "body { font-family: 'Inter', sans-serif; }");
    const findings = await brandTokensRule.check([f], { brand: { fonts: ['Inter'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips non-UI files (.go)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'server/handler.go', '// color: #ff0000');
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips comment-only lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const f = makeTmpFile(dir, 'src/a.tsx', '// Old brand color was #ff0000');
    const findings = await brandTokensRule.check([f], { brand: { colors: ['#f97316'] } });
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('registry', () => {
  it('brand-tokens is registered', () => {
    assert.ok(listAvailableRules().includes('brand-tokens'));
  });
});
