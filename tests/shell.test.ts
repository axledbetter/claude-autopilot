import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSafe, runThrowing } from '../src/core/shell.ts';
import { AutopilotError } from '../src/core/errors.ts';

test('runSafe returns stdout on success', () => {
  const out = runSafe('node', ['-e', 'process.stdout.write("ok")']);
  assert.equal(out, 'ok');
});

test('runSafe returns null on non-zero exit', () => {
  const out = runSafe('node', ['-e', 'process.exit(1)']);
  assert.equal(out, null);
});

test('runThrowing throws AutopilotError on non-zero exit', () => {
  assert.throws(
    () => runThrowing('node', ['-e', 'process.exit(2)']),
    (err: unknown) => {
      assert.ok(err instanceof AutopilotError);
      assert.equal(err.code, 'transient_network');
      return true;
    }
  );
});
