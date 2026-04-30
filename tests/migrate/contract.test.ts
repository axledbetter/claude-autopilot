// tests/migrate/contract.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_CONTRACT_VERSION,
  RESULT_ARTIFACT_MAX_BYTES,
  RESERVED_SIDE_EFFECTS,
  SHELL_METACHARS,
  TRUSTED_SKILL_ROOTS,
  RESULT_TEMPDIR_MODE,
} from '../../src/core/migrate/contract.ts';

describe('migrate contract constants', () => {
  it('exports envelope contract version', () => {
    assert.equal(ENVELOPE_CONTRACT_VERSION, '1.0');
  });

  it('caps result artifact at 1 MB', () => {
    assert.equal(RESULT_ARTIFACT_MAX_BYTES, 1_048_576);
  });

  it('reserves the v1 side-effect vocabulary', () => {
    assert.ok(RESERVED_SIDE_EFFECTS.includes('types-regenerated'));
    assert.ok(RESERVED_SIDE_EFFECTS.includes('no-side-effects'));
    assert.equal(RESERVED_SIDE_EFFECTS.length, 6);
  });

  it('shell metachar regex rejects pipes, redirects, command substitution', () => {
    assert.ok(SHELL_METACHARS.test('foo|bar'));
    assert.ok(SHELL_METACHARS.test('foo;bar'));
    assert.ok(SHELL_METACHARS.test('foo&bar'));
    assert.ok(SHELL_METACHARS.test('foo`bar`'));
    assert.ok(SHELL_METACHARS.test('foo$(bar)'));
    assert.ok(!SHELL_METACHARS.test('safe-arg'));
    assert.ok(!SHELL_METACHARS.test('--flag=value'));
  });

  it('trusted skill roots include skills/ and node_modules/', () => {
    assert.ok(TRUSTED_SKILL_ROOTS.includes('skills/'));
    assert.ok(TRUSTED_SKILL_ROOTS.includes('node_modules/'));
  });

  it('temp dir mode is 0700 (owner-only)', () => {
    assert.equal(RESULT_TEMPDIR_MODE, 0o700);
  });
});
