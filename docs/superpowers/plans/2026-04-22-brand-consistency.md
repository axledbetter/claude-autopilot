# Brand Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `brand-tokens` static rule that flags hardcoded colors/fonts in UI files not matching the project's canonical design token palette, configured via a `brand` block in `guardrail.config.yaml`.

**Architecture:** New static rule reads brand config from `GuardrailConfig.brand` at check time, extracts the canonical palette from an optional `colorsFrom` Tailwind config path plus explicit `colors` array, then scans each UI file line-by-line for hardcoded hex values and off-palette arbitrary Tailwind classes. Config schema and TypeScript types extended in-place. `--focus brand` wired into the existing scan focus union type.

**Tech Stack:** Node.js 22+, TypeScript ESM, `node:fs` for file reads, existing `StaticRule` interface, AJV schema for config validation.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/core/static-rules/rules/brand-tokens.ts` | Create | The rule — palette resolution + line scanner |
| `src/core/static-rules/tailwind-extractor.ts` | Create | Parse `tailwind.config.{ts,js,cjs,mjs}` to extract color values |
| `src/core/config/types.ts` | Modify | Add `brand?` field to `GuardrailConfig` |
| `src/core/config/schema.ts` | Modify | Add `brand` object to AJV schema |
| `src/core/static-rules/registry.ts` | Modify | Register `brand-tokens` in BUILTIN map |
| `src/cli/scan.ts` | Modify | Add `'brand'` to `focus` union type |
| `src/cli/index.ts` | Modify | Add `'brand'` to `--focus` validation |
| `tests/brand-tokens.test.ts` | Create | Unit tests: palette resolution + rule findings |

---

## Task 1: Config types + schema

**Files:**
- Modify: `src/core/config/types.ts`
- Modify: `src/core/config/schema.ts`

- [ ] **Step 1: Write failing test for config schema accepting brand block**

Create `tests/brand-tokens.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep -E "ok |not ok |# fail"
```

Expected: tests fail (brand not in schema yet)

- [ ] **Step 3: Add `brand` to `GuardrailConfig` in types.ts**

In `src/core/config/types.ts`, add after the `cost?` block (before the closing brace):

```typescript
  brand?: {
    /** Path to tailwind.config.{ts,js} — auto-extracts theme.colors as canonical palette */
    colorsFrom?: string;
    /** Explicit canonical color values (hex/rgb/hsl). Merged with colorsFrom. */
    colors?: string[];
    /** Canonical font family names */
    fonts?: string[];
    /** Path to design system component library (informational, for future LLM review) */
    componentLibrary?: string;
  };
```

- [ ] **Step 4: Add `brand` to schema in schema.ts**

In `src/core/config/schema.ts`, add after the `cost` property block (before `cache`):

```typescript
    brand: {
      type: 'object',
      properties: {
        colorsFrom: { type: 'string' },
        colors: { type: 'array', items: { type: 'string' } },
        fonts: { type: 'array', items: { type: 'string' } },
        componentLibrary: { type: 'string' },
      },
      additionalProperties: false,
    },
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep -E "ok |not ok |# fail|# pass"
```

Expected: 4 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
cd /tmp/claude-autopilot && git add src/core/config/types.ts src/core/config/schema.ts tests/brand-tokens.test.ts && git commit -m "feat(brand): add brand config block to GuardrailConfig type and schema"
```

---

## Task 2: Tailwind color extractor

**Files:**
- Create: `src/core/static-rules/tailwind-extractor.ts`

- [ ] **Step 1: Add tests for the extractor to tests/brand-tokens.test.ts**

Append these imports and describe block to the existing `tests/brand-tokens.test.ts`:

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractTailwindColors } from '../src/core/static-rules/tailwind-extractor.ts';

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep "not ok"
```

Expected: extractor tests fail (module doesn't exist)

- [ ] **Step 3: Create `src/core/static-rules/tailwind-extractor.ts`**

```typescript
import * as fs from 'node:fs';

const HEX_COLOR = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/**
 * Extract canonical hex color values from a Tailwind config file.
 * Uses regex extraction — reads theme.colors and theme.extend.colors values.
 * Returns normalized lowercase hex strings, deduplicated.
 */
export function extractTailwindColors(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }

  // Narrow to theme block to avoid false matches outside theme config
  const themeMatch = content.match(/theme\s*[=:]\s*\{([\s\S]*)/);
  const searchContent = themeMatch ? themeMatch[0] : content;

  const colors = new Set<string>();
  HEX_COLOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_COLOR.exec(searchContent)) !== null) {
    const raw = m[0]!.toLowerCase();
    // Expand 3-digit shorthand to 6-digit
    if (raw.length === 4) {
      const r = raw[1]!, g = raw[2]!, b = raw[3]!;
      colors.add(`#${r}${r}${g}${g}${b}${b}`);
    } else {
      colors.add(raw);
    }
  }

  return [...colors];
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep -E "# pass|# fail"
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot && git add src/core/static-rules/tailwind-extractor.ts tests/brand-tokens.test.ts && git commit -m "feat(brand): Tailwind color extractor with regex-based theme.colors parsing"
```

---

## Task 3: `brand-tokens` static rule

**Files:**
- Create: `src/core/static-rules/rules/brand-tokens.ts`

- [ ] **Step 1: Add rule tests to tests/brand-tokens.test.ts**

Append these imports and describe block:

```typescript
import { brandTokensRule } from '../src/core/static-rules/rules/brand-tokens.ts';

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep "not ok"
```

Expected: rule tests fail (module doesn't exist)

- [ ] **Step 3: Create `src/core/static-rules/rules/brand-tokens.ts`**

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';
import { extractTailwindColors } from '../tailwind-extractor.ts';

const UI_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss', '.sass', '.less', '.html', '.vue', '.svelte']);
const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const TAILWIND_ARBITRARY_HEX = /(?:bg|text|border|ring|fill|stroke|from|to|via)-\[#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\]/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}\n]+)/g;
const CSS_EXTS = new Set(['.css', '.scss', '.sass', '.less']);

function normalizeHex(hex: string): string {
  const h = hex.toLowerCase();
  if (h.length === 4) {
    const r = h[1]!, g = h[2]!, b = h[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return h;
}

function buildPalette(
  brandCfg: { colorsFrom?: string; colors?: string[] },
  cwd: string,
): Set<string> | null {
  const hasColorsFrom = !!brandCfg.colorsFrom;
  const hasColors = Array.isArray(brandCfg.colors) && brandCfg.colors.length > 0;
  if (!hasColorsFrom && !hasColors) return null;

  const palette = new Set<string>();
  if (hasColorsFrom) {
    const cfgPath = path.isAbsolute(brandCfg.colorsFrom!)
      ? brandCfg.colorsFrom!
      : path.resolve(cwd, brandCfg.colorsFrom!);
    for (const c of extractTailwindColors(cfgPath)) palette.add(normalizeHex(c));
  }
  for (const c of brandCfg.colors ?? []) palette.add(normalizeHex(c));
  return palette;
}

export const brandTokensRule: StaticRule = {
  name: 'brand-tokens',
  severity: 'warning',

  async check(touchedFiles: string[], config: Record<string, unknown> = {}): Promise<Finding[]> {
    const brandCfg = config.brand as
      | { colorsFrom?: string; colors?: string[]; fonts?: string[] }
      | undefined;

    if (!brandCfg) return [];

    const cwd = process.cwd();
    const palette = buildPalette(brandCfg, cwd);
    const canonicalFonts = brandCfg.fonts?.map(f => f.toLowerCase()) ?? [];
    const findings: Finding[] = [];

    for (const file of touchedFiles) {
      const ext = path.extname(file);
      if (!UI_EXTS.has(ext)) continue;

      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        if (palette && palette.size > 0) {
          HEX_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = HEX_RE.exec(line)) !== null) {
            const hex = normalizeHex(m[0]!);
            if (!palette.has(hex)) {
              const palettePreview = [...palette].slice(0, 5).join(', ');
              findings.push({
                id: `brand-tokens:${file}:${i + 1}`,
                source: 'static-rules',
                severity: 'warning',
                category: 'brand-tokens',
                file,
                line: i + 1,
                message: `Off-brand color ${hex} is not in the canonical palette`,
                suggestion: `Use a brand token. Canonical colors: ${palettePreview}${palette.size > 5 ? ` (+${palette.size - 5} more)` : ''}`,
                protectedPath: false,
                createdAt: new Date().toISOString(),
              });
            }
          }

          TAILWIND_ARBITRARY_HEX.lastIndex = 0;
          while ((m = TAILWIND_ARBITRARY_HEX.exec(line)) !== null) {
            const hex = normalizeHex(`#${m[1]!}`);
            if (!palette.has(hex)) {
              findings.push({
                id: `brand-tokens:tailwind:${file}:${i + 1}`,
                source: 'static-rules',
                severity: 'warning',
                category: 'brand-tokens',
                file,
                line: i + 1,
                message: `Off-brand Tailwind arbitrary color ${hex} is not in the canonical palette`,
                suggestion: `Replace with a Tailwind token from your brand palette (e.g. bg-primary, text-brand)`,
                protectedPath: false,
                createdAt: new Date().toISOString(),
              });
            }
          }
        }

        if (canonicalFonts.length > 0 && CSS_EXTS.has(ext)) {
          FONT_FAMILY_RE.lastIndex = 0;
          let fm: RegExpExecArray | null;
          while ((fm = FONT_FAMILY_RE.exec(line)) !== null) {
            const declaration = fm[1]!;
            const declared = declaration.split(',').map(f => f.trim().replace(/['"]/g, '').toLowerCase());
            const hasCanonical = declared.some(f => canonicalFonts.some(cf => f.includes(cf)));
            if (!hasCanonical) {
              findings.push({
                id: `brand-tokens:font:${file}:${i + 1}`,
                source: 'static-rules',
                severity: 'warning',
                category: 'brand-tokens',
                file,
                line: i + 1,
                message: `Off-brand font-family "${declaration.trim()}" — not in canonical fonts list`,
                suggestion: `Use one of the canonical fonts: ${canonicalFonts.join(', ')}`,
                protectedPath: false,
                createdAt: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    return findings;
  },
};
```

- [ ] **Step 4: Run tests**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep -E "# pass|# fail"
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-autopilot && git add src/core/static-rules/rules/brand-tokens.ts tests/brand-tokens.test.ts && git commit -m "feat(brand): brand-tokens static rule — flags off-palette colors and fonts in UI files"
```

---

## Task 4: Register rule + wire `--focus brand`

**Files:**
- Modify: `src/core/static-rules/registry.ts`
- Modify: `src/cli/scan.ts` (line 63)
- Modify: `src/cli/index.ts` (focus validation)

- [ ] **Step 1: Write registry test**

Append to `tests/brand-tokens.test.ts`:

```typescript
import { listAvailableRules } from '../src/core/static-rules/registry.ts';

describe('registry', () => {
  it('brand-tokens is registered', () => {
    assert.ok(listAvailableRules().includes('brand-tokens'));
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep "brand-tokens is registered"
```

Expected: `not ok`

- [ ] **Step 3: Register in registry.ts**

In `src/core/static-rules/registry.ts`, add to the BUILTIN object after `'insecure-redirect'`:

```typescript
  // Brand rules
  'brand-tokens':       () => import('./rules/brand-tokens.ts').then(m => m.brandTokensRule),
```

- [ ] **Step 4: Add `'brand'` to scan focus type in scan.ts**

In `src/cli/scan.ts` at line 63, change:

```typescript
  focus?: 'security' | 'logic' | 'performance' | 'all';
```

to:

```typescript
  focus?: 'security' | 'logic' | 'performance' | 'brand' | 'all';
```

- [ ] **Step 5: Add `'brand'` to --focus validation in index.ts**

In `src/cli/index.ts`, find:

```typescript
    if (focusArg && !['security', 'logic', 'performance', 'all'].includes(focusArg)) {
```

Change to:

```typescript
    if (focusArg && !['security', 'logic', 'performance', 'brand', 'all'].includes(focusArg)) {
```

- [ ] **Step 6: Run all brand tests**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs tests/brand-tokens.test.ts 2>&1 | grep -E "# pass|# fail"
```

Expected: all pass

- [ ] **Step 7: Commit**

```bash
cd /tmp/claude-autopilot && git add src/core/static-rules/registry.ts src/cli/scan.ts src/cli/index.ts tests/brand-tokens.test.ts && git commit -m "feat(brand): register brand-tokens rule, add --focus brand to scan command"
```

---

## Task 5: Full suite green + version bump

- [ ] **Step 1: Run full test suite**

```bash
cd /tmp/claude-autopilot && node scripts/test-runner.mjs 2>&1 | tail -5
```

Expected: `# pass N` with `# fail 0`

- [ ] **Step 2: Bump version to 4.2.0 in package.json**

In `package.json`, change `"version": "4.1.0"` to `"version": "4.2.0"`.

- [ ] **Step 3: Commit and push**

```bash
cd /tmp/claude-autopilot && git add package.json && git commit -m "chore: bump to 4.2.0 (brand-tokens rule)" && git push origin master
```

---

## Self-Review

**Spec coverage:**
- brand-tokens static rule: Task 3
- colorsFrom Tailwind extraction: Task 2
- Explicit colors palette (merged with colorsFrom): Task 3 buildPalette
- Fonts checking: Task 3
- Config type + schema: Task 1
- Registry registration: Task 4
- --focus brand: Task 4
- No-op when brand absent: Task 3 test
- Arbitrary Tailwind classes: Task 3

**Placeholder scan:** None — all steps have concrete code.

**Type consistency:** brandTokensRule.check second param is `Record<string, unknown>` matching StaticRule interface pattern used by sql-injection and other rules.
