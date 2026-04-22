import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, makeDebouncer } from '../../src/cli/watch.ts';

describe('isIgnored', () => {
  it('W1: ignores node_modules paths', () => {
    assert.equal(isIgnored('/proj/node_modules/react/index.js'), true);
  });

  it('W2: ignores .git/ paths', () => {
    assert.equal(isIgnored('/proj/.git/COMMIT_EDITMSG'), true);
  });

  it('W3: ignores .log files', () => {
    assert.equal(isIgnored('/proj/server.log'), true);
  });

  it('W4: ignores .guardrail-cache paths', () => {
    assert.equal(isIgnored('/home/user/.guardrail-cache/reviews/abc.json'), true);
  });

  it('W5: does not ignore normal .ts source files', () => {
    assert.equal(isIgnored('/proj/src/app.ts'), false);
  });

  it('W6: does not ignore preset yaml files', () => {
    assert.equal(isIgnored('/proj/presets/t3/guardrail.config.yaml'), false);
  });

  it('W7: ignores tilde backup files', () => {
    assert.equal(isIgnored('/proj/src/app.ts~'), true);
  });
});

describe('makeDebouncer', () => {
  it('W8: accumulates files before debounce fires', async () => {
    const batches: string[][] = [];
    const d = makeDebouncer(b => batches.push(b), 50);
    d.schedule('a.ts');
    d.schedule('b.ts');
    assert.equal(d.pending().length, 2);
    assert.equal(batches.length, 0); // not fired yet
    await new Promise(r => setTimeout(r, 80));
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.sort(), ['a.ts', 'b.ts']);
  });

  it('W9: resets timer on rapid events — single flush with all files', async () => {
    const batches: string[][] = [];
    const d = makeDebouncer(b => batches.push(b), 60);
    d.schedule('x.ts');
    await new Promise(r => setTimeout(r, 20));
    d.schedule('y.ts');
    await new Promise(r => setTimeout(r, 20));
    d.schedule('z.ts');
    // only 40ms elapsed since last event, debounce not fired
    assert.equal(batches.length, 0);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.sort(), ['x.ts', 'y.ts', 'z.ts']);
  });

  it('W10: deduplicates the same file scheduled multiple times', async () => {
    const batches: string[][] = [];
    const d = makeDebouncer(b => batches.push(b), 50);
    d.schedule('dup.ts');
    d.schedule('dup.ts');
    d.schedule('dup.ts');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(batches[0]!.length, 1);
    assert.equal(batches[0]![0], 'dup.ts');
  });

  it('W11: pending() reflects files not yet flushed', () => {
    const d = makeDebouncer(() => {}, 10000); // long debounce
    d.schedule('a.ts');
    d.schedule('b.ts');
    const p = d.pending();
    assert.ok(p.includes('a.ts'));
    assert.ok(p.includes('b.ts'));
  });

  it('W12: separate debounce windows produce separate batches', async () => {
    const batches: string[][] = [];
    const d = makeDebouncer(b => batches.push(b), 40);
    d.schedule('first.ts');
    await new Promise(r => setTimeout(r, 60));
    d.schedule('second.ts');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0], ['first.ts']);
    assert.deepEqual(batches[1], ['second.ts']);
  });
});
