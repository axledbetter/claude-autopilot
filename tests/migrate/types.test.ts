// tests/migrate/types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InvocationEnvelope, ResultArtifact, SkillManifest } from '../../src/core/migrate/types.ts';

describe('migrate types', () => {
  it('InvocationEnvelope has all required fields', () => {
    const env: InvocationEnvelope = {
      contractVersion: '1.0',
      invocationId: 'uuid',
      nonce: 'nonce-hex',
      trigger: 'cli',
      attempt: 1,
      repoRoot: '/r',
      cwd: '/r',
      changedFiles: [],
      env: 'dev',
      dryRun: false,
      ci: false,
      gitBase: 'sha',
      gitHead: 'sha',
    };
    assert.equal(env.contractVersion, '1.0');
  });

  it('ResultArtifact has all required fields', () => {
    const r: ResultArtifact = {
      contractVersion: '1.0',
      skillId: 'migrate@1',
      invocationId: 'uuid',
      nonce: 'nonce-hex',
      status: 'applied',
      reasonCode: 'ok',
      appliedMigrations: [],
      destructiveDetected: false,
      sideEffectsPerformed: ['no-side-effects'],
      nextActions: [],
    };
    assert.equal(r.status, 'applied');
  });

  it('SkillManifest has version handshake fields', () => {
    const m: SkillManifest = {
      skillId: 'migrate@1',
      skill_runtime_api_version: '1.0',
      min_runtime: '5.2.0',
      max_runtime: '5.x',
      stdoutFallback: false,
    };
    assert.equal(m.skill_runtime_api_version, '1.0');
  });
});
