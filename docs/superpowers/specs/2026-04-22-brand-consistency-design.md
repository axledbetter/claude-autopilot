# Brand Consistency Checking Design

## Goal

When guardrail reviews UI files (`.tsx`, `.jsx`, `.css`, `.scss`), it should detect deviations from the project's established brand tokens — hardcoded colors not in the palette, wrong font families, and off-brand arbitrary Tailwind values — and report them as findings alongside security and logic issues.

## Context

Guardrail started as the autopilot validation tool. When autopilot writes or modifies UI components, it can unknowingly introduce brand drift: hardcoded hex colors, wrong font stacks, arbitrary spacing values that don't match the design system. This feature closes that gap by adding brand-awareness to the existing static rules pipeline.

## Design

### 1. New static rule: `brand-tokens`

A new entry in the static rules registry. Runs at the static phase (before LLM) so it's fast and requires no API key.

**What it checks:**
- Hardcoded hex/rgb/hsl color values in JSX/TSX/CSS that are not in the canonical palette
- `font-family` values not in the configured font list
- Arbitrary Tailwind color classes (`bg-[#abc123]`, `text-[#fff000]`) not in the palette
- `style={{ color: '...' }}` / `style={{ backgroundColor: '...' }}` inline styles with off-palette values

**Finding severity:** `warning` (brand drift is not a blocker, but should be flagged)

**Finding category:** `brand-tokens`

### 2. Brand config block in `guardrail.config.yaml`

```yaml
brand:
  colorsFrom: tailwind.config.ts   # auto-extract theme.colors (optional)
  colors:                          # explicit palette (merges with colorsFrom)
    - '#f97316'   # orange primary
    - '#1a1f3a'   # navy background
    - '#ffffff'   # white
    - '#000000'   # black
  fonts:
    - 'Inter'
    - 'Geist'
  componentLibrary: app/components/ui/   # path hint for future LLM brand review
```

`colorsFrom` is parsed at rule-load time: reads the Tailwind config, extracts `theme.colors` and `theme.extend.colors` values recursively. Explicit `colors` entries are merged in. If neither is set, the rule is a no-op (opt-in).

### 3. `--focus brand` scan mode

`guardrail scan --focus brand src/` injects a brand-aware review prompt into the LLM review phase. The prompt includes the canonical palette and asks the model to assess component hierarchy, spacing rhythm, dark mode consistency, and whether new components match the existing design system's visual language.

This extends the existing `focus` parameter (`security | logic | performance | brand`).

### 4. Config schema extension

`GuardrailConfig.brand` optional field:
```typescript
brand?: {
  colorsFrom?: string;
  colors?: string[];
  fonts?: string[];
  componentLibrary?: string;
};
```

### 5. Integration with autopilot watch

When `guardrail watch` detects changes to UI files (`.tsx`, `.jsx`), the brand-tokens static rule runs automatically as part of the existing static phase — no special wiring needed since static rules always run.

## Architecture

- `src/core/static-rules/rules/brand-tokens.ts` — the rule implementation
- `src/core/static-rules/tailwind-extractor.ts` — parses Tailwind config to extract color palette
- `src/core/config/types.ts` — add `brand?` field to `GuardrailConfig`
- `src/core/config/schema.ts` — add `brand` to AJV schema
- `src/core/static-rules/registry.ts` — register `brand-tokens`
- `tests/brand-tokens.test.ts` — unit tests for the rule and extractor

## Out of Scope

- Visual screenshot diffing (future)
- LLM vision-based brand review (future)
- Auto-fixing brand violations (future — `guardrail fix` could substitute canonical tokens)
- Enforcing component-level design system usage beyond color/font

## Test Plan

- Rule returns no findings when brand config absent (opt-in)
- Rule flags hardcoded hex not in palette
- Rule passes hex values that are in the palette
- Rule flags arbitrary Tailwind color classes off-palette
- Rule passes arbitrary Tailwind color classes in palette
- Rule flags off-brand font-family in CSS
- `colorsFrom` extraction correctly reads Tailwind config theme.colors
- `colorsFrom` with `extend.colors` included
- `--focus brand` is accepted as valid focus param
- Config schema validates `brand` block
