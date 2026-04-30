// src/core/migrate/envelope.ts
//
// Builds an InvocationEnvelope for a migrate dispatch. Generates a
// per-call invocationId (UUID v4) and nonce (32-byte hex), reads
// gitBase/gitHead via git rev-parse, auto-detects CI from env vars.

import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import type { InvocationEnvelope } from './types.ts';
import { ENVELOPE_CONTRACT_VERSION } from './contract.ts';

export interface BuildEnvelopeOptions {
  changedFiles: string[];
  env: string;
  repoRoot: string;
  cwd?: string;
  dryRun?: boolean;
  ci?: boolean;            // override; default = detectCI().ci
  projectId?: string;
  attempt?: number;        // default 1; bumped on retry
  trigger?: 'cli' | 'ci';  // default = ci ? 'ci' : 'cli'
}

export interface CIDetectionResult {
  ci: boolean;
  provider: string | null;
  overridden: boolean;
}

/**
 * Detect whether we're running in CI and which provider, based on
 * standard env-var markers. AUTOPILOT_CI_PROVIDER overrides the
 * detected value (with audit-log evidence).
 */
export function detectCI(): CIDetectionResult {
  const override = process.env.AUTOPILOT_CI_PROVIDER;
  if (override) {
    return { ci: true, provider: override, overridden: true };
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    return { ci: true, provider: 'github-actions', overridden: false };
  }
  if (process.env.GITLAB_CI === 'true') {
    return { ci: true, provider: 'gitlab', overridden: false };
  }
  if (process.env.CIRCLECI === 'true') {
    return { ci: true, provider: 'circleci', overridden: false };
  }
  if (process.env.BUILDKITE === 'true') {
    return { ci: true, provider: 'buildkite', overridden: false };
  }
  if (process.env.JENKINS_URL) {
    return { ci: true, provider: 'jenkins', overridden: false };
  }
  // CI=true alone (no recognized provider) — ci:true, provider:null.
  // Policy enforcer treats this as "missing provider" and blocks prod.
  if (process.env.CI === 'true') {
    return { ci: true, provider: null, overridden: false };
  }
  return { ci: false, provider: null, overridden: false };
}

function readGitRef(ref: string, cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    throw new Error(
      `buildEnvelope: not in a git repo or rev-parse failed for ${ref}: ${(err as Error).message}`,
    );
  }
}

export function buildEnvelope(opts: BuildEnvelopeOptions): InvocationEnvelope {
  const ciInfo = detectCI();
  const ci = opts.ci ?? ciInfo.ci;
  const trigger = opts.trigger ?? (ci ? 'ci' : 'cli');
  const cwd = opts.cwd ?? opts.repoRoot;

  const gitHead = readGitRef('HEAD', opts.repoRoot);
  // Use HEAD~1 as base; if no parent (initial commit), reuse HEAD.
  let gitBase: string;
  try {
    gitBase = readGitRef('HEAD~1', opts.repoRoot);
  } catch {
    gitBase = gitHead;
  }

  return {
    contractVersion: ENVELOPE_CONTRACT_VERSION,
    invocationId: randomUUID(),
    nonce: randomBytes(32).toString('hex'),
    trigger,
    attempt: opts.attempt ?? 1,
    repoRoot: opts.repoRoot,
    cwd,
    changedFiles: opts.changedFiles,
    env: opts.env,
    dryRun: opts.dryRun ?? false,
    ci,
    gitBase,
    gitHead,
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  };
}
