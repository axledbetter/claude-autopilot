import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewEngine, ReviewInput } from '../../adapters/review-engine/types.ts';
import type { AutopilotConfig } from '../config/types.ts';

export interface ReviewChunk {
  content: string;
  kind: ReviewInput['kind'];
  files: string[];
}

export interface BuildChunksInput {
  touchedFiles: string[];
  strategy: 'auto' | 'single-pass' | 'file-level';
  chunking?: AutopilotConfig['chunking'];
  engine: ReviewEngine;
  cwd?: string;
}

const DEFAULT_SMALL_TIER_TOKENS = 8000;
const DEFAULT_FILE_TIER_TOKENS = 60000;

export async function buildReviewChunks(input: BuildChunksInput): Promise<ReviewChunk[]> {
  const smallMax = input.chunking?.smallTierMaxTokens ?? DEFAULT_SMALL_TIER_TOKENS;
  const fileMax = input.chunking?.perFileMaxTokens ?? DEFAULT_FILE_TIER_TOKENS;

  const fileContents = await readFiles(input.touchedFiles, input.cwd);

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
