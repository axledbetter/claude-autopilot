import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { GenericDeployAdapter, type SpawnFn } from '../src/adapters/deploy/generic.ts';
import { GuardrailError } from '../src/core/errors.ts';

/**
 * Minimal child-process stub satisfying the slice of the API the adapter uses.
 * Emits stdout/stderr chunks then a `close` event with the supplied exit code.
 */
function fakeSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): { spawn: SpawnFn } {
  const spawn: SpawnFn = () => {
    const child = new EventEmitter() as unknown as ReturnType<SpawnFn>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    setImmediate(() => {
      if (opts.stdout) stdout.emit('data', Buffer.from(opts.stdout, 'utf8'));
      if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
      (child as unknown as EventEmitter).emit('close', opts.exitCode);
    });
    return child;
  };
  return { spawn };
}

describe('GenericDeployAdapter', () => {
  it('passes when command exits 0 and extracts URL from stdout', async () => {
    const { spawn } = fakeSpawn({
      stdout: 'Building...\nDeployed: https://my-app-abc.vercel.app/\nDone.\n',
      exitCode: 0,
    });
    const adapter = new GenericDeployAdapter({
      deployCommand: 'fake-deploy',
      spawnImpl: spawn,
      quiet: true,
    });
    const r = await adapter.deploy({});
    assert.equal(r.status, 'pass');
    assert.equal(r.deployUrl, 'https://my-app-abc.vercel.app/');
  });

  it('fails when command exits non-zero', async () => {
    const { spawn } = fakeSpawn({
      stderr: 'Error: token expired\n',
      exitCode: 1,
    });
    const adapter = new GenericDeployAdapter({
      deployCommand: 'fake-deploy',
      spawnImpl: spawn,
      quiet: true,
    });
    const r = await adapter.deploy({});
    assert.equal(r.status, 'fail');
    assert.ok(r.output?.includes('token expired'));
  });

  it('throws GuardrailError(invalid_config) when deployCommand is empty', () => {
    assert.throws(
      () => new GenericDeployAdapter({ deployCommand: '   ' }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'invalid_config',
    );
  });
});
