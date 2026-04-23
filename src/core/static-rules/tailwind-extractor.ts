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
