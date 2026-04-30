import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadConfig } from '../src/core/config/loader.ts';
import { createDeployAdapter } from '../src/adapters/deploy/index.ts';
import { GuardrailError } from '../src/core/errors.ts';

function tmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deploy-schema-'));
  const p = path.join(dir, 'guardrail.config.yaml');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('deploy config schema', () => {
  it('accepts a vercel deploy block', async () => {
    const p = tmpConfig(`configVersion: 1
deploy:
  adapter: vercel
  project: my-app
  team: team_xyz
  target: production
`);
    const cfg = await loadConfig(p);
    assert.equal(cfg.deploy?.adapter, 'vercel');
    assert.equal(cfg.deploy?.project, 'my-app');
    assert.equal(cfg.deploy?.target, 'production');
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it('accepts a generic deploy block', async () => {
    const p = tmpConfig(`configVersion: 1
deploy:
  adapter: generic
  deployCommand: "vercel --prod"
  healthCheckUrl: "https://example.com/healthz"
`);
    const cfg = await loadConfig(p);
    assert.equal(cfg.deploy?.adapter, 'generic');
    assert.equal(cfg.deploy?.deployCommand, 'vercel --prod');
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it('rejects an invalid adapter value', async () => {
    const p = tmpConfig(`configVersion: 1
deploy:
  adapter: heroku
  project: my-app
`);
    await assert.rejects(loadConfig(p), /adapter|enum|invalid_config/i);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });
});

describe('createDeployAdapter factory', () => {
  it('throws invalid_config when vercel adapter has no project', () => {
    assert.throws(
      () => createDeployAdapter({ adapter: 'vercel' }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
  });

  it('throws invalid_config when generic adapter has no deployCommand', () => {
    assert.throws(
      () => createDeployAdapter({ adapter: 'generic' }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
  });
});
