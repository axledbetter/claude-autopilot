import { runSafe } from '../shell.ts';

const IGNORE_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  'out/',
  'coverage/',
  '.turbo/',
  '.cache/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'target/',        // Rust/Java
  '.gradle/',
];

function isIgnored(file: string): boolean {
  return IGNORE_PREFIXES.some(p => file.startsWith(p));
}

export interface TouchedFilesOptions {
  cwd?: string;
  base?: string; // e.g. 'HEAD~1', 'main', a SHA — defaults to HEAD~1
}

/**
 * Returns the list of files changed relative to `base` (default HEAD~1).
 * Falls back to `git status --short` unstaged/staged files if the diff fails
 * (e.g. first commit, no parent).
 */
export function resolveGitTouchedFiles(options: TouchedFilesOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const base = options.base ?? 'HEAD~1';

  // Primary: diff against base
  const diffOut = runSafe('git', ['diff', '--name-only', base, 'HEAD'], { cwd });
  if (diffOut !== null && diffOut.trim().length > 0) {
    return parseFileList(diffOut);
  }

  // Fallback: staged + unstaged working tree changes
  const statusOut = runSafe('git', ['status', '--short'], { cwd });
  if (statusOut !== null && statusOut.trim().length > 0) {
    return parseStatusOutput(statusOut);
  }

  return [];
}

function parseFileList(output: string): string[] {
  return [...new Set(output.split('\n').map(l => l.trim()).filter(Boolean).filter(f => !isIgnored(f)))];
}

function parseStatusOutput(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // format: XY filename  (or XY old -> new for renames)
    const parts = trimmed.replace(/^\S+\s+/, '');
    const renamed = parts.match(/^(.+)\s+->\s+(.+)$/);
    if (renamed) {
      files.add(renamed[2]!.trim());
    } else {
      files.add(parts.trim());
    }
  }
  return [...files].filter(f => !isIgnored(f));
}
