import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticRule, StaticRuleContext } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';
import { extractTailwindColors } from '../tailwind-extractor.ts';

const UI_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss', '.sass', '.less', '.html', '.vue', '.svelte']);
const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const TAILWIND_ARBITRARY_HEX = /(?:bg|text|border|ring|fill|stroke|from|to|via)-\[#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\]/g;
// Matches the hex portion inside a Tailwind arbitrary color bracket so we can strip it before plain HEX_RE scan
const TAILWIND_ARBITRARY_HEX_STRIP = /(?:bg|text|border|ring|fill|stroke|from|to|via)-\[#[0-9a-fA-F]{3,6}\]/g;
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

  async check(touchedFiles: string[], ctx: StaticRuleContext = {}): Promise<Finding[]> {
    const brandCfg = ctx.config?.brand;

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
          // Check Tailwind arbitrary color classes first, then scan remaining line for plain hex
          TAILWIND_ARBITRARY_HEX.lastIndex = 0;
          let m: RegExpExecArray | null;
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

          // Strip Tailwind arbitrary color brackets before plain hex scan to avoid double-reporting
          const lineWithoutTailwindArbitrary = line.replace(TAILWIND_ARBITRARY_HEX_STRIP, '');
          HEX_RE.lastIndex = 0;
          while ((m = HEX_RE.exec(lineWithoutTailwindArbitrary)) !== null) {
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
