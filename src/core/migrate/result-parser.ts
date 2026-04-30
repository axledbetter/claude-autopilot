// src/core/migrate/result-parser.ts
//
// Parses ResultArtifact from a skill subprocess. File transport is
// primary and mandatory by default; stdout fallback is opt-in (per
// skill manifest) and nonce-bound to defend against subprocess output
// spoofing.
//
// Invariants:
// - All errors return a synthetic ResultArtifact with status='error',
//   so the dispatcher always has a typed object to act on.
// - Required fields enforced; unknown fields ignored (forward compat
//   for minor envelope-contract version increments).
// - Major contract version mismatch is a hard error.

import * as fs from 'node:fs';
import type { ResultArtifact, ResultStatus, SideEffect } from './types.ts';
import {
  ENVELOPE_CONTRACT_VERSION,
  RESULT_ARTIFACT_MAX_BYTES,
  RESERVED_SIDE_EFFECTS,
  STDOUT_MARKER_BEGIN_PREFIX,
  STDOUT_MARKER_END_PREFIX,
  STDOUT_MARKER_SUFFIX,
} from './contract.ts';

const VALID_STATUSES: readonly ResultStatus[] = [
  'applied', 'skipped', 'validation-failed', 'needs-human', 'error',
];
const VALID_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(RESERVED_SIDE_EFFECTS as readonly SideEffect[]);

export interface ExpectedIdentity {
  invocationId: string;
  nonce: string;
}

interface ParseOpts {
  filePath: string;
  stdout: string;
  expected: ExpectedIdentity;
  allowStdoutFallback: boolean;
}

function syntheticError(reasonCode: string, _message: string, expected: ExpectedIdentity): ResultArtifact {
  return {
    contractVersion: ENVELOPE_CONTRACT_VERSION,
    skillId: 'unknown',
    invocationId: expected.invocationId,
    nonce: expected.nonce,
    status: 'error',
    reasonCode,
    appliedMigrations: [],
    destructiveDetected: false,
    sideEffectsPerformed: ['no-side-effects'],
    nextActions: [],
  };
}

function isValidArtifact(o: unknown): o is ResultArtifact {
  if (!o || typeof o !== 'object') return false;
  const a = o as Record<string, unknown>;
  if (typeof a.contractVersion !== 'string') return false;
  if (typeof a.skillId !== 'string') return false;
  if (typeof a.invocationId !== 'string') return false;
  if (typeof a.nonce !== 'string') return false;
  if (typeof a.reasonCode !== 'string') return false;
  if (typeof a.destructiveDetected !== 'boolean') return false;
  if (!Array.isArray(a.appliedMigrations) || !a.appliedMigrations.every(x => typeof x === 'string')) return false;
  if (!Array.isArray(a.nextActions) || !a.nextActions.every(x => typeof x === 'string')) return false;
  if (!Array.isArray(a.sideEffectsPerformed)) return false;
  if (!a.sideEffectsPerformed.every(x => typeof x === 'string' && VALID_SIDE_EFFECTS.has(x as SideEffect))) return false;
  if (!VALID_STATUSES.includes(a.status as ResultStatus)) return false;
  return true;
}

function checkContractVersion(o: ResultArtifact): { ok: true } | { ok: false; reason: string } {
  const major = (s: string) => s.split('.')[0];
  if (major(o.contractVersion) !== major(ENVELOPE_CONTRACT_VERSION)) {
    return { ok: false, reason: 'unsupported-contract-version' };
  }
  return { ok: true };
}

function checkIdentity(o: ResultArtifact, expected: ExpectedIdentity): { ok: true } | { ok: false; reason: string } {
  if (o.invocationId !== expected.invocationId) return { ok: false, reason: 'invocationId-mismatch' };
  if (o.nonce !== expected.nonce) return { ok: false, reason: 'nonce-mismatch' };
  return { ok: true };
}

function parseAndValidate(raw: string, expected: ExpectedIdentity): ResultArtifact {
  if (Buffer.byteLength(raw, 'utf8') > RESULT_ARTIFACT_MAX_BYTES) {
    return syntheticError('result-too-large', 'artifact exceeds 1 MB', expected);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return syntheticError('invalid-result-artifact', 'JSON parse failed', expected);
  }
  if (!isValidArtifact(parsed)) {
    return syntheticError('invalid-result-artifact', 'required fields missing or wrong type', expected);
  }
  const cv = checkContractVersion(parsed);
  if (!cv.ok) return syntheticError(cv.reason, 'contract version mismatch', expected);
  const id = checkIdentity(parsed, expected);
  if (!id.ok) return syntheticError(id.reason, 'identity mismatch', expected);
  return parsed;
}

export function parseResultFromFile(filePath: string, expected: ExpectedIdentity): ResultArtifact {
  // Verify file ownership + type before reading. Use lstatSync (not statSync)
  // so we don't follow symlinks — the dispatcher pre-creates a regular file
  // with O_EXCL, so anything else here means tampering or a misbehaving skill.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return syntheticError('result-file-missing', `cannot stat ${filePath}`, expected);
  }
  if (!stat.isFile()) {
    return syntheticError(
      'result-file-not-regular',
      `result path is not a regular file: ${filePath}`,
      expected,
    );
  }
  if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) {
    return syntheticError(
      'result-file-wrong-owner',
      `result file uid ${stat.uid} does not match process uid`,
      expected,
    );
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return syntheticError('result-file-missing', `cannot read ${filePath}`, expected);
  }
  return parseAndValidate(raw, expected);
}

export function parseResultFromStdout(stdout: string, expected: ExpectedIdentity): ResultArtifact {
  const beginMarker = `${STDOUT_MARKER_BEGIN_PREFIX}${expected.nonce}${STDOUT_MARKER_SUFFIX}`;
  const endMarker = `${STDOUT_MARKER_END_PREFIX}${expected.nonce}${STDOUT_MARKER_SUFFIX}`;
  const beginIdx = stdout.indexOf(beginMarker);
  if (beginIdx === -1) {
    return syntheticError('result-not-found-in-stdout', 'BEGIN marker missing or nonce mismatch', expected);
  }
  const afterBegin = beginIdx + beginMarker.length;
  const endIdx = stdout.indexOf(endMarker, afterBegin);
  if (endIdx === -1) {
    return syntheticError('result-truncated', 'END marker missing', expected);
  }
  const payload = stdout.slice(afterBegin, endIdx).trim();
  return parseAndValidate(payload, expected);
}

export function parseResult(opts: ParseOpts): ResultArtifact {
  // File transport is mandatory by default. Try it first.
  const fromFile = parseResultFromFile(opts.filePath, opts.expected);
  if (fromFile.status !== 'error' || fromFile.reasonCode !== 'result-file-missing') {
    return fromFile;
  }
  // File missing and stdout fallback enabled → try stdout
  if (opts.allowStdoutFallback) {
    return parseResultFromStdout(opts.stdout, opts.expected);
  }
  // Otherwise file-missing is the answer
  return fromFile;
}
