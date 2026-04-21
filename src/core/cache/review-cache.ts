import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewOutput } from '../../adapters/review-engine/types.ts';

export interface CacheEntry {
  key: string;
  output: ReviewOutput;
  createdAt: string;
  expiresAt: string;
}

export interface ReviewCacheOptions {
  cacheDir?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Prefer env override, then ~/.autopilot-cache to survive across cwd changes and container restarts
const DEFAULT_CACHE_DIR = process.env.AUTOPILOT_CACHE_DIR
  ? path.join(process.env.AUTOPILOT_CACHE_DIR, 'reviews')
  : path.join(os.homedir(), '.autopilot-cache', 'reviews');

export class ReviewCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;

  constructor(options: ReviewCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  static keyFor(adapterName: string, model: string, content: string): string {
    return createHash('sha256').update(`${adapterName}:${model}:${content}`).digest('hex');
  }

  async get(key: string): Promise<ReviewOutput | undefined> {
    const filePath = this.entryPath(key);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry = JSON.parse(raw);
      if (new Date(entry.expiresAt) < new Date()) {
        await fs.unlink(filePath).catch(() => undefined);
        return undefined;
      }
      return entry.output;
    } catch {
      return undefined;
    }
  }

  async set(key: string, output: ReviewOutput): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const entry: CacheEntry = {
      key,
      output,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    const filePath = this.entryPath(key);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
    await fs.rename(tmp, filePath);
  }

  private entryPath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }
}
