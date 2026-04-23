// src/core/schema-alignment/detector.ts
import type { SchemaAlignmentConfig } from './types.ts';

const DEFAULT_PATTERNS: RegExp[] = [
  /data[/\\]deltas[/\\].+\.sql$/,
  /supabase[/\\]migrations[/\\].+\.sql$/,
  /prisma[/\\]migrations[/\\].+\.sql$/,
  /prisma[/\\]schema\.prisma$/,
  /db[/\\]migrate[/\\].+\.rb$/,
  /drizzle[/\\].+\.ts$/,
  /[/\\]migrations[/\\].+\.py$/,
];

function globToPattern(glob: string): RegExp {
  let escaped = glob;

  // Escape regex special chars except * and /
  escaped = escaped.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace **/ with placeholder (matches zero or more intermediate directories)
  escaped = escaped.replace(/\*\*\//g, '___DSTAR_SLASH___');

  // Replace remaining ** with placeholder
  escaped = escaped.replace(/\*\*/g, '___DSTAR___');

  // Replace / with placeholder BEFORE handling * so we don't mess up character classes
  escaped = escaped.replace(/\//g, '___SLASH___');

  // Replace single * with placeholder (to preserve it before / restoration)
  escaped = escaped.replace(/\*/g, '___STAR___');

  // Now restore placeholders in the right order
  // Restore / as [/\\\\] to match both forward and back slashes
  // NOTE: In RegExp constructor, \\ becomes \, so [/\\] needs to be [/\\\\]
  escaped = escaped.replace(/___SLASH___/g, '[/\\\\]');

  // Restore * as [^/]* (matches anything except /)
  escaped = escaped.replace(/___STAR___/g, '[^/]*');

  // Restore **/ as optional directory segments with trailing separator
  escaped = escaped.replace(/___DSTAR_SLASH___/g, '(?:.*[/\\\\])?');

  // Restore remaining ** as .* (matches anything including /)
  escaped = escaped.replace(/___DSTAR___/g, '.*');

  const re = new RegExp(escaped + '$');
  return re;
}

export function detect(touchedFiles: string[], config?: SchemaAlignmentConfig): string[] {
  if (config?.enabled === false) return [];

  const patterns = [...DEFAULT_PATTERNS];
  for (const glob of config?.migrationGlobs ?? []) {
    patterns.push(globToPattern(glob));
  }

  return touchedFiles.filter(f => patterns.some(re => re.test(f)));
}
