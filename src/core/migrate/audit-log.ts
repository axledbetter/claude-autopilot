// src/core/migrate/audit-log.ts
//
// JSONL audit log with monotonic seq + prev_hash chain. Concurrent writes
// serialized via proper-lockfile (advisory lock with retries + stale recovery).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import lockfile from 'proper-lockfile';

export interface AuditEvent {
  seq: number;
  ts: string;
  invocationId: string;
  event: string;
  requested_skill: string;
  resolved_skill: string;
  skill_path: string;
  envelope_contract_version: string;
  skill_runtime_api_version: string;
  envelope_hash: string;
  policy_decisions: string[];
  mode: 'apply' | 'dry-run' | 'doctor-fix';
  actor: string;
  ci_provider: string | null;
  ci_run_id: string | null;
  result_status: string;
  duration_ms: number;
  prev_hash: string | null;
}

export type AuditEventInput = Omit<AuditEvent, 'seq' | 'prev_hash' | 'ts'>;

function sha256(s: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function readLastLine(p: string): { seq: number; lineHash: string } | null {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return null;
  const lines = raw.trim().split('\n');
  const last = lines[lines.length - 1]!;
  const obj = JSON.parse(last) as AuditEvent;
  return { seq: obj.seq, lineHash: sha256(last) };
}

export async function appendAuditEvent(logPath: string, input: AuditEventInput): Promise<void> {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');

  const release = await lockfile.lock(logPath, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    stale: 5000,
  });
  try {
    const last = readLastLine(logPath);
    const seq = (last?.seq ?? 0) + 1;
    const prev_hash = last?.lineHash ?? null;
    const event: AuditEvent = {
      ...input,
      seq,
      prev_hash,
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  } finally {
    await release();
  }
}

export function readEvents(logPath: string): AuditEvent[] {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => JSON.parse(line) as AuditEvent);
}

export interface VerifyResult {
  valid: boolean;
  breakAtLine?: number;
  reason?: string;
}

export function verifyChain(logPath: string): VerifyResult {
  const lines = (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '').trim();
  if (!lines) return { valid: true };
  const arr = lines.split('\n');
  let expectedSeq = 1;
  let expectedPrevHash: string | null = null;
  for (let i = 0; i < arr.length; i++) {
    const lineNo = i + 1;
    const line = arr[i]!;
    let obj: AuditEvent;
    try {
      obj = JSON.parse(line) as AuditEvent;
    } catch {
      return { valid: false, breakAtLine: lineNo, reason: 'invalid-json' };
    }
    if (obj.seq !== expectedSeq) {
      return { valid: false, breakAtLine: lineNo, reason: `seq mismatch: expected ${expectedSeq}, got ${obj.seq}` };
    }
    if (obj.prev_hash !== expectedPrevHash) {
      return { valid: false, breakAtLine: lineNo, reason: 'prev_hash mismatch' };
    }
    expectedSeq += 1;
    expectedPrevHash = sha256(line);
  }
  return { valid: true };
}
