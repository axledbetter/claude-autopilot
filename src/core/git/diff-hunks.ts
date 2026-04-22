import { runSafe } from '../shell.ts';

export interface FileDiff {
  file: string;
  hunks: string;  // unified diff content for this file (header + hunks)
  additions: number;
  deletions: number;
}

/**
 * Returns per-file unified diffs for the given files between base and HEAD.
 * Falls back to working-tree diff (unstaged) when base diff is empty for a file.
 */
export function getFileDiffs(cwd: string, base: string, files: string[]): FileDiff[] {
  if (files.length === 0) return [];

  // Get full diff in one shot — more efficient than per-file calls
  const raw = runSafe('git', ['diff', base, 'HEAD', '--unified=3', '--', ...files], { cwd })
    ?? runSafe('git', ['diff', 'HEAD', '--unified=3', '--', ...files], { cwd })
    ?? '';

  return parseUnifiedDiff(raw, files);
}

/**
 * Parses unified diff output into per-file FileDiff entries.
 * Only returns files that actually have diff content.
 */
export function parseUnifiedDiff(raw: string, requestedFiles: string[]): FileDiff[] {
  if (!raw.trim()) return [];

  const results: FileDiff[] = [];
  const sections = raw.split(/^(?=diff --git )/m).filter(Boolean);

  const requested = new Set(requestedFiles.map(f => f.replace(/\\/g, '/')));

  for (const section of sections) {
    // Extract b/ filename from diff header: diff --git a/src/foo.ts b/src/foo.ts
    const headerMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!headerMatch) continue;
    const file = headerMatch[1]!.trim();
    if (!requested.has(file)) continue;

    // Strip the git binary/index header lines, keep hunk content
    const hunkStart = section.indexOf('@@');
    const hunks = hunkStart >= 0 ? section.slice(hunkStart) : '';
    if (!hunks.trim()) continue;

    let additions = 0;
    let deletions = 0;
    for (const line of hunks.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    results.push({ file, hunks: hunks.trimEnd(), additions, deletions });
  }

  return results;
}

/**
 * Formats FileDiff entries into a review-ready string.
 * Total size is bounded by maxChars (default 120K chars ≈ 30K tokens).
 */
export function formatDiffContent(diffs: FileDiff[], maxChars = 120_000): string {
  const parts: string[] = [];
  let total = 0;
  let skipped = 0;

  for (const d of diffs) {
    const section = `## ${d.file} (+${d.additions}/-${d.deletions})\n\`\`\`diff\n${d.hunks}\n\`\`\``;
    if (total + section.length > maxChars) {
      skipped++;
      continue;
    }
    parts.push(section);
    total += section.length;
  }

  if (skipped > 0) {
    parts.push(`[${skipped} file${skipped !== 1 ? 's' : ''} omitted — diff exceeded size limit]`);
  }

  return parts.join('\n\n');
}
