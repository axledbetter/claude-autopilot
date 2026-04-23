import type { Finding } from '../findings/types.ts';
import type { GuardrailConfig } from '../config/types.ts';
import type { WorkerLock } from './lockfile.ts';

export interface WorkerReviewRequest {
  files: string[];
  config: GuardrailConfig;
}

export interface WorkerReviewResponse {
  findings: Finding[];
  usage?: { costUSD: number };
}

export async function dispatchToWorker(
  lock: WorkerLock,
  req: WorkerReviewRequest,
): Promise<WorkerReviewResponse> {
  const url = `http://127.0.0.1:${lock.port}/review`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Worker returned ${res.status}: ${await res.text()}`);
  return res.json() as Promise<WorkerReviewResponse>;
}

export async function getWorkerStatus(lock: WorkerLock): Promise<{
  pid: number; port: number; jobsProcessed: number; queueDepth: number; uptimeMs: number;
}> {
  const url = `http://127.0.0.1:${lock.port}/status`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Worker status returned ${res.status}`);
  return res.json() as Promise<{ pid: number; port: number; jobsProcessed: number; queueDepth: number; uptimeMs: number }>;
}

export async function stopWorker(lock: WorkerLock): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${lock.port}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* worker may have already exited */ }
}
