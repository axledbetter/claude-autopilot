import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performHandshake } from '../../src/core/migrate/handshake.ts';
import type { SkillManifest } from '../../src/core/migrate/types.ts';

function makeSkillDir(manifest: Partial<SkillManifest> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'skill.manifest.json'), JSON.stringify(manifest));
  }
  return dir;
}

const VALID_MANIFEST: SkillManifest = {
  skillId: 'migrate@1',
  skill_runtime_api_version: '1.0',
  min_runtime: '5.2.0',
  max_runtime: '5.x',
};

describe('performHandshake', () => {
  it('accepts when runtime is within range and API major matches envelope contract', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('accepts when runtime is at upper bound (5.9.99 against 5.x)', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.9.99', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('rejects when runtime below min_runtime', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.1.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'runtime-below-min');
    assert.match(r.message!, /5\.2\.0/);
    fs.rmSync(dir, { recursive: true });
  });

  it('rejects when runtime above max_runtime (5.x → 6.0.0)', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '6.0.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'runtime-above-max');
    fs.rmSync(dir, { recursive: true });
  });

  it('rejects when API major mismatches envelope contract', () => {
    const dir = makeSkillDir({ ...VALID_MANIFEST, skill_runtime_api_version: '2.0' });
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'api-version-mismatch');
    fs.rmSync(dir, { recursive: true });
  });

  it('rejects pre-release runtime against >=5.2.0 (semver strictness)', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0-beta', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    fs.rmSync(dir, { recursive: true });
  });

  it('fails closed when manifest file missing', () => {
    const dir = makeSkillDir(null);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'manifest-missing');
    fs.rmSync(dir, { recursive: true });
  });

  it('fails closed when manifest is malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
    fs.writeFileSync(path.join(dir, 'skill.manifest.json'), '{broken');
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'manifest-invalid');
    fs.rmSync(dir, { recursive: true });
  });

  it('fails closed when manifest missing required fields', () => {
    const dir = makeSkillDir({ skillId: 'foo@1' } as Partial<SkillManifest>);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, 'manifest-invalid');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns the manifest in the result on success', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.2.0', envelopeContractVersion: '1.0' });
    if (r.ok) {
      assert.equal(r.manifest.skillId, 'migrate@1');
    } else {
      assert.fail(`expected ok, got: ${r.reasonCode}`);
    }
    fs.rmSync(dir, { recursive: true });
  });

  it('error result includes upgrade message with concrete versions', () => {
    const dir = makeSkillDir(VALID_MANIFEST);
    const r = performHandshake({ skillPath: dir, runtimeVersion: '5.0.0', envelopeContractVersion: '1.0' });
    assert.equal(r.ok, false);
    assert.match(r.message!, /5\.0\.0/);
    assert.match(r.message!, /5\.2\.0/);
    fs.rmSync(dir, { recursive: true });
  });
});
