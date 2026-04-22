import * as fs from 'node:fs';
import * as path from 'node:path';

export type Provider = 'anthropic' | 'gemini' | 'openai' | 'groq';

const PROVIDER_PATTERNS: Record<Provider, RegExp> = {
  anthropic: /ANTHROPIC_API_KEY|@anthropic-ai\/sdk|anthropic\.com|claude-[a-z0-9]/gi,
  gemini:    /GEMINI_API_KEY|GOOGLE_API_KEY|@google\/generative-ai|generativelanguage\.googleapis/gi,
  openai:    /OPENAI_API_KEY|openai\.com|gpt-[0-9]/gi,
  groq:      /GROQ_API_KEY|api\.groq\.com/gi,
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out',
  'coverage', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.cache', '.turbo']);

function walkSync(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSync(full, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

export interface ProviderCounts {
  anthropic: number;
  gemini: number;
  openai: number;
  groq: number;
}

/**
 * Scans source files under `cwd` and returns per-provider match counts.
 * Counts are capped at 1 per file to avoid skewing on generated lock files.
 */
export function detectProviderUsage(cwd: string): ProviderCounts {
  const counts: ProviderCounts = { anthropic: 0, gemini: 0, openai: 0, groq: 0 };
  const files = walkSync(cwd);
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [provider, pattern] of Object.entries(PROVIDER_PATTERNS) as [Provider, RegExp][]) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) counts[provider]++;
    }
  }
  return counts;
}

/**
 * Returns the provider with the highest usage count, or null if all zero.
 */
export function dominantProvider(counts: ProviderCounts): Provider | null {
  const entries = Object.entries(counts) as [Provider, number][];
  const max = Math.max(...entries.map(([, v]) => v));
  if (max === 0) return null;
  return entries.find(([, v]) => v === max)![0];
}
