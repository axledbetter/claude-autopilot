import { readLock, writeLock, deleteLock, isWorkerAlive } from '../core/worker/lockfile.ts';
import { stopWorker, getWorkerStatus } from '../core/worker/client.ts';
import { startWorkerServer } from '../core/worker/server.ts';
import { loadConfig } from '../core/config/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };

export async function runWorker(sub: string | undefined, options: { cwd?: string; configPath?: string } = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  switch (sub) {
    case 'start':
      return workerStart(cwd, configPath);
    case 'stop':
      return workerStop(cwd);
    case 'status':
      return workerStatus(cwd);
    default:
      console.error(`${C.red}[worker] Unknown subcommand: "${sub ?? ''}". Use start|stop|status${C.reset}`);
      return 1;
  }
}

async function workerStart(cwd: string, configPath: string): Promise<number> {
  const existing = readLock(cwd);
  if (existing && isWorkerAlive(existing)) {
    console.log(`${C.yellow}[worker] Already running — pid ${existing.pid} port ${existing.port}${C.reset}`);
    return 0;
  }

  let config = { configVersion: 1 as const };
  if (fs.existsSync(configPath)) {
    const loaded = await loadConfig(configPath);
    if (loaded) config = loaded;
  }

  // Lazy import to avoid loading review engine at CLI startup
  const { loadAdapter } = await import('../adapters/loader.ts');
  const { runReviewPhase } = await import('../core/pipeline/review-phase.ts');

  const engineRef = (config as { reviewEngine?: unknown }).reviewEngine;
  const ref = typeof engineRef === 'string' ? engineRef : (engineRef as { adapter?: string })?.adapter ?? 'auto';
  const engineOptions = typeof engineRef === 'object' && engineRef !== null
    ? (engineRef as { options?: Record<string, unknown> }).options
    : undefined;

  const engine = await loadAdapter({
    point: 'review-engine',
    ref,
    options: engineOptions,
  });

  const server = await startWorkerServer({
    cwd,
    onReview: async (files, cfg) => {
      const result = await runReviewPhase({ touchedFiles: files, config: cfg, engine: engine as unknown as ReviewEngine });
      return { findings: result.findings, usage: result.costUSD !== undefined ? { costUSD: result.costUSD } : undefined };
    },
  });

  writeLock(cwd, { pid: process.pid, port: server.port, startedAt: new Date().toISOString() });

  const cleanup = () => { deleteLock(cwd); server.close().then(() => process.exit(0)); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  console.log(`${C.green}[worker] Started — pid ${process.pid} port ${server.port}${C.reset}`);
  console.log(`${C.dim}  guardrail run --use-worker   # dispatch review chunks to this worker${C.reset}`);

  await new Promise(() => {}); // keep alive
  return 0;
}

async function workerStop(cwd: string): Promise<number> {
  const lock = readLock(cwd);
  if (!lock) { console.log('[worker] No worker running'); return 0; }
  if (!isWorkerAlive(lock)) { deleteLock(cwd); console.log('[worker] Stale lockfile removed'); return 0; }
  await stopWorker(lock);
  // Give it 3s to exit, then SIGTERM
  await new Promise(r => setTimeout(r, 1000));
  if (isWorkerAlive(lock)) {
    try { process.kill(lock.pid, 'SIGTERM'); } catch { /* already dead */ }
  }
  deleteLock(cwd);
  console.log(`${C.green}[worker] Stopped${C.reset}`);
  return 0;
}

async function workerStatus(cwd: string): Promise<number> {
  const lock = readLock(cwd);
  if (!lock) { console.log('[worker] Not running'); return 1; }
  if (!isWorkerAlive(lock)) { console.log(`[worker] Dead (stale lock — pid ${lock.pid})`); return 1; }
  try {
    const status = await getWorkerStatus(lock);
    console.log(`[worker] Running`);
    console.log(`  pid:            ${status.pid}`);
    console.log(`  port:           ${status.port}`);
    console.log(`  jobs processed: ${status.jobsProcessed}`);
    console.log(`  uptime:         ${Math.round(status.uptimeMs / 1000)}s`);
    return 0;
  } catch {
    console.log(`[worker] Running (pid ${lock.pid} port ${lock.port}) — status endpoint unreachable`);
    return 0;
  }
}
