// src/core/migrate/dispatcher.ts
//
// Orchestrates the full migrate flow:
//   1. Read .autopilot/stack.md, validate schema
//   2. Resolve migrate.skill via alias map (path-escape protected)
//   3. Skill manifest handshake (runtime range + API version)
//   4. Build invocation envelope (UUID, nonce, git refs)
//   5. Enforce policy (4-flag CI prod gate, clean git, etc.)
//   6. Execute the env command via spawn(shell:false), capturing the
//      result artifact (file or nonce-bound stdout fallback)
//   7. Parse the result artifact, validate identity
//   8. Append audit log entry (seq + prev_hash)
//
// Fails closed at every step. Always emits an audit entry, even on
// failure, so operators can see what was attempted.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { validateStackMd } from './schema-validator.ts';
import { resolveSkill } from './alias-resolver.ts';
import { performHandshake } from './handshake.ts';
import { buildEnvelope } from './envelope.ts';
import { enforcePolicy, type PolicyConfig } from './policy-enforcer.ts';
import { executeCommand, type ExecuteResult } from './executor.ts';
import { parseResult } from './result-parser.ts';
import { appendAuditEvent } from './audit-log.ts';
import { ENVELOPE_CONTRACT_VERSION, RESULT_TEMPDIR_MODE } from './contract.ts';
import type { ResultArtifact, CommandSpec, InvocationEnvelope } from './types.ts';

export interface DispatchOptions {
  repoRoot: string;
  env: string;
  yesFlag: boolean;
  nonInteractive: boolean;
  /** Runtime version, normally from package.json. */
  currentRuntimeVersion: string;
  /** Override env_file lookup (mainly for tests) */
  envOverride?: Record<string, string>;
  /** Optional changedFiles for envelope (passes through verbatim) */
  changedFiles?: string[];
  /** dryRun pass-through to the envelope */
  dryRun?: boolean;
  /** projectId for monorepo invocations */
  projectId?: string;
}

interface StackMd {
  migrate: {
    skill: string;
    envs?: Record<string, {
      command: CommandSpec;
      env_file?: string;
    }>;
    post?: Array<{ command: CommandSpec }>;
    policy?: Partial<PolicyConfig>;
    project_root?: string;
  };
}

const DEFAULT_POLICY: PolicyConfig = {
  allow_prod_in_ci: false,
  require_clean_git: true,
  require_manual_approval: true,
  require_dry_run_first: false,
};

function readStackMd(repoRoot: string): { ok: true; raw: string; parsed: StackMd } | { ok: false; reason: string } {
  const stackPath = path.join(repoRoot, '.autopilot', 'stack.md');
  if (!fs.existsSync(stackPath)) return { ok: false, reason: 'stack.md not found' };
  const raw = fs.readFileSync(stackPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return { ok: false, reason: 'stack.md YAML parse failed' };
  }
  return { ok: true, raw, parsed: parsed as StackMd };
}

function loadEnvFile(envFilePath: string, repoRoot: string): Record<string, string> {
  const abs = path.resolve(repoRoot, envFilePath);
  if (!fs.existsSync(abs)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function hashEnvelope(env: InvocationEnvelope): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(env)).digest('hex');
}

interface AuditFailureContext {
  invocationId?: string;
  requested?: string;
  resolved?: string;
  skillPath?: string;
  apiVersion?: string;
  decisions?: string[];
  durationMs?: number;
  envelopeHash?: string;
}

async function emitAuditFailure(
  repoRoot: string,
  opts: DispatchOptions,
  reasonCode: string,
  partial: AuditFailureContext,
): Promise<void> {
  try {
    await appendAuditEvent(path.join(repoRoot, '.autopilot', 'audit.log'), {
      invocationId: partial.invocationId ?? 'pre-envelope',
      event: 'dispatch',
      requested_skill: partial.requested ?? 'unknown',
      resolved_skill: partial.resolved ?? 'unknown',
      skill_path: partial.skillPath ?? '',
      envelope_contract_version: ENVELOPE_CONTRACT_VERSION,
      skill_runtime_api_version: partial.apiVersion ?? 'unknown',
      envelope_hash: partial.envelopeHash ?? '',
      policy_decisions: partial.decisions ?? [],
      mode: opts.dryRun ? 'dry-run' : 'apply',
      actor: process.env.USER ?? 'unknown',
      ci_provider: process.env.AUTOPILOT_CI_PROVIDER ?? null,
      ci_run_id: process.env.GITHUB_RUN_ID ?? null,
      result_status: `error:${reasonCode}`,
      duration_ms: partial.durationMs ?? 0,
    });
  } catch {
    // last-ditch: don't let audit-log failure mask the real error
  }
}

function synthErr(
  reasonCode: string,
  invocationId = 'pre-envelope',
  nonce = '',
): ResultArtifact {
  return {
    contractVersion: ENVELOPE_CONTRACT_VERSION,
    skillId: 'unknown',
    invocationId,
    nonce,
    status: 'error',
    reasonCode,
    appliedMigrations: [],
    destructiveDetected: false,
    sideEffectsPerformed: ['no-side-effects'],
    nextActions: [],
  };
}

export async function dispatch(opts: DispatchOptions): Promise<ResultArtifact> {
  const t0 = Date.now();

  // 1. Read + validate stack.md
  const stackResult = readStackMd(opts.repoRoot);
  if (!stackResult.ok) {
    await emitAuditFailure(opts.repoRoot, opts, 'invalid-stack-config', {});
    return synthErr('invalid-stack-config');
  }
  const validation = validateStackMd(stackResult.raw);
  if (!validation.valid) {
    const msg = validation.errors.map(e => e.message).join('; ');
    // Map known validator errors to a more specific reason code where possible
    const reasonCode = /stableSkillId|skillId-not-in-registry/.test(msg)
      ? 'stable-id-unknown'
      : 'invalid-stack-config';
    await emitAuditFailure(opts.repoRoot, opts, reasonCode, {});
    return synthErr(reasonCode);
  }
  const requestedSkill = stackResult.parsed.migrate.skill;

  // 2. Resolve alias
  const resolved = resolveSkill(requestedSkill, { repoRoot: opts.repoRoot });
  if (!resolved.ok) {
    await emitAuditFailure(opts.repoRoot, opts, resolved.reasonCode, {
      requested: requestedSkill,
    });
    return synthErr(resolved.reasonCode);
  }

  // 3. Handshake
  const handshake = performHandshake({
    skillPath: resolved.skillPath,
    runtimeVersion: opts.currentRuntimeVersion,
    envelopeContractVersion: ENVELOPE_CONTRACT_VERSION,
  });
  if (!handshake.ok) {
    await emitAuditFailure(opts.repoRoot, opts, handshake.reasonCode, {
      requested: requestedSkill,
      resolved: resolved.stableId,
      skillPath: resolved.skillPath,
    });
    return synthErr(handshake.reasonCode);
  }

  // 4. Envelope
  let envelope: InvocationEnvelope;
  try {
    envelope = buildEnvelope({
      changedFiles: opts.changedFiles ?? [],
      env: opts.env,
      repoRoot: opts.repoRoot,
      dryRun: opts.dryRun ?? false,
      projectId: opts.projectId,
    });
  } catch {
    await emitAuditFailure(opts.repoRoot, opts, 'envelope-build-failed', {
      requested: requestedSkill,
      resolved: resolved.stableId,
      skillPath: resolved.skillPath,
      apiVersion: handshake.manifest.skill_runtime_api_version,
    });
    return synthErr('envelope-build-failed');
  }
  const envelopeHash = hashEnvelope(envelope);

  // 5. Policy
  const policy: PolicyConfig = { ...DEFAULT_POLICY, ...(stackResult.parsed.migrate.policy ?? {}) };
  const enforced = enforcePolicy({
    policy,
    env: opts.env,
    repoRoot: opts.repoRoot,
    ci: envelope.ci,
    yesFlag: opts.yesFlag,
    nonInteractive: opts.nonInteractive,
    gitHead: envelope.gitHead,
  });
  if (!enforced.ok) {
    await emitAuditFailure(opts.repoRoot, opts, enforced.reasonCode, {
      invocationId: envelope.invocationId,
      requested: requestedSkill,
      resolved: resolved.stableId,
      skillPath: resolved.skillPath,
      apiVersion: handshake.manifest.skill_runtime_api_version,
      decisions: enforced.decisions,
      envelopeHash,
    });
    return synthErr(enforced.reasonCode, envelope.invocationId, envelope.nonce);
  }

  // 6. Execute
  const envSpec = stackResult.parsed.migrate.envs?.[opts.env];
  if (!envSpec) {
    await emitAuditFailure(opts.repoRoot, opts, 'env-not-configured', {
      invocationId: envelope.invocationId,
      requested: requestedSkill,
      resolved: resolved.stableId,
      skillPath: resolved.skillPath,
      apiVersion: handshake.manifest.skill_runtime_api_version,
      decisions: enforced.decisions,
      envelopeHash,
    });
    return synthErr('env-not-configured', envelope.invocationId, envelope.nonce);
  }

  // Set up per-invocation result file with strict permissions
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-result-'));
  fs.chmodSync(tmpRoot, RESULT_TEMPDIR_MODE);
  const resultPath = path.join(tmpRoot, `${envelope.invocationId}.json`);

  // Pre-create result file with O_CREAT|O_EXCL|O_WRONLY, mode 0o600, no symlink follow.
  // The skill will then open the existing file for writing — TOCTOU window closed
  // against a malicious pre-placed file or symlink.
  const fd = fs.openSync(
    resultPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  fs.closeSync(fd);

  const childEnv: Record<string, string> = {
    ...(envSpec.env_file ? loadEnvFile(envSpec.env_file, opts.repoRoot) : {}),
    ...(opts.envOverride ?? {}),
    AUTOPILOT_ENVELOPE: JSON.stringify(envelope),
    AUTOPILOT_RESULT_PATH: resultPath,
  };

  let execResult: ExecuteResult;
  try {
    execResult = await executeCommand(envSpec.command, {
      cwd: opts.repoRoot,
      env: childEnv,
    });
  } catch {
    await emitAuditFailure(opts.repoRoot, opts, 'execute-threw', {
      invocationId: envelope.invocationId,
      requested: requestedSkill,
      resolved: resolved.stableId,
      skillPath: resolved.skillPath,
      apiVersion: handshake.manifest.skill_runtime_api_version,
      decisions: enforced.decisions,
      envelopeHash,
    });
    try { fs.rmSync(tmpRoot, { recursive: true }); } catch { /* */ }
    return synthErr('execute-threw', envelope.invocationId, envelope.nonce);
  }

  // 7. Parse result artifact
  const allowStdoutFallback = handshake.manifest.stdoutFallback === true;
  const result = parseResult({
    filePath: resultPath,
    stdout: execResult.stdout,
    expected: { invocationId: envelope.invocationId, nonce: envelope.nonce },
    allowStdoutFallback,
  });

  // Cleanup temp dir
  try { fs.rmSync(tmpRoot, { recursive: true }); } catch { /* */ }

  // 8. Audit log entry (always emitted on the success path)
  const durationMs = Date.now() - t0;
  await appendAuditEvent(path.join(opts.repoRoot, '.autopilot', 'audit.log'), {
    invocationId: envelope.invocationId,
    event: 'dispatch',
    requested_skill: requestedSkill,
    resolved_skill: resolved.stableId,
    skill_path: resolved.skillPath,
    envelope_contract_version: ENVELOPE_CONTRACT_VERSION,
    skill_runtime_api_version: handshake.manifest.skill_runtime_api_version,
    envelope_hash: envelopeHash,
    policy_decisions: enforced.decisions,
    mode: opts.dryRun ? 'dry-run' : 'apply',
    actor: process.env.USER ?? 'unknown',
    ci_provider: process.env.AUTOPILOT_CI_PROVIDER ?? null,
    ci_run_id: process.env.GITHUB_RUN_ID ?? null,
    result_status: result.status,
    duration_ms: durationMs,
  });

  return result;
}
