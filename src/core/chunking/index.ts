import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewEngine, ReviewInput } from '../../adapters/review-engine/types.ts';
import type { AutopilotConfig } from '../config/types.ts';
import { rankByRisk } from './risk-ranker.ts';
import { getFileDiffs, formatDiffContent } from '../git/diff-hunks.ts';

export interface ReviewChunk {
  content: string;
  kind: ReviewInput['kind'];
  files: string[];
}

export interface BuildChunksInput {
  touchedFiles: string[];
  strategy: 'auto' | 'single-pass' | 'file-level' | 'diff';
  chunking?: AutopilotConfig['chunking'];
  engine: ReviewEngine;
  cwd?: string;
  protectedPaths?: string[];
  base?: string;  // git base ref — required for 'diff' strategy
}

const DEFAULT_SMALL_TIER_TOKENS = 8000;
const DEFAULT_FILE_TIER_TOKENS = 60000;

export async function buildReviewChunks(input: BuildChunksInput): Promise<ReviewChunk[]> {
  const smallMax = input.chunking?.smallTierMaxTokens ?? DEFAULT_SMALL_TIER_TOKENS;
  const fileMax = input.chunking?.perFileMaxTokens ?? DEFAULT_FILE_TIER_TOKENS;

  // Diff strategy: send unified diff hunks instead of full file contents
  if (input.strategy === 'diff') {
    return buildDiffChunks(input);
  }

  const ranked = rankByRisk(input.touchedFiles, { protectedPaths: input.protectedPaths });
  const fileContents = await readFiles(ranked, input.cwd);

  if (input.strategy === 'single-pass') {
    const combined = formatBatch(fileContents);
    return [{ content: combined, kind: 'file-batch', files: [...fileContents.keys()] }];
  }

  if (input.strategy === 'auto') {
    const combined = formatBatch(fileContents);
    if (input.engine.estimateTokens(combined) <= smallMax) {
      return [{ content: combined, kind: 'file-batch', files: [...fileContents.keys()] }];
    }
    // fall through to file-level
  }

  // file-level: one chunk per readable file, truncated to fileMax tokens
  const chunks: ReviewChunk[] = [];
  for (const [filePath, content] of fileContents) {
    const truncated = truncateToTokens(content, fileMax, input.engine);
    chunks.push({ content: `// File: ${filePath}\n${truncated}`, kind: 'file-batch', files: [filePath] });
  }
  return chunks;
}

function buildDiffChunks(input: BuildChunksInput): ReviewChunk[] {
  const cwd = input.cwd ?? process.cwd();
  const base = input.base ?? 'HEAD~1';
  const ranked = rankByRisk(input.touchedFiles, { protectedPaths: input.protectedPaths });
  const diffs = getFileDiffs(cwd, base, ranked);

  if (diffs.length === 0) return [];

  // Single chunk — diff content is already compact; truncation handled in formatDiffContent
  const content = formatDiffContent(diffs);
  return [{ content, kind: 'file-batch', files: diffs.map(d => d.file) }];
}

async function readFiles(touchedFiles: string[], cwd?: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const f of touchedFiles) {
    const resolved = cwd ? path.resolve(cwd, f) : path.resolve(f);
    try {
      result.set(f, await fs.readFile(resolved, 'utf8'));
    } catch {
      // deleted or unreadable — skip silently
    }
  }
  return result;
}

function formatBatch(fileContents: Map<string, string>): string {
  const parts: string[] = [];
  for (const [filePath, content] of fileContents) {
    parts.push(`// File: ${filePath}\n${content}`);
  }
  return parts.join('\n\n---\n\n');
}

function truncateToTokens(content: string, maxTokens: number, engine: ReviewEngine): string {
  if (engine.estimateTokens(content) <= maxTokens) return content;
  let lo = 0;
  let hi = content.length;
  while (hi - lo > 128) {
    const mid = (lo + hi) >> 1;
    if (engine.estimateTokens(content.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid;
  }
  return content.slice(0, lo) + '\n// [truncated]';
}
