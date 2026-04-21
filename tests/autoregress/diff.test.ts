import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffBaselines } from '../../scripts/autoregress.ts';

describe('diffBaselines', () => {
  it('returns empty array when baseline and current match', () => {
    const json = JSON.stringify({ a: 1, b: 'hello' }, null, 2);
    const lines = diffBaselines(json, json);
    assert.equal(lines.length, 0);
  });

  it('returns diff lines when values differ', () => {
    const baseline = JSON.stringify({ a: 1, b: 'old' }, null, 2);
    const current = JSON.stringify({ a: 1, b: 'new' }, null, 2);
    const lines = diffBaselines(baseline, current);
    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.includes('old')), 'should show removed line');
    assert.ok(lines.some(l => l.includes('new')), 'should show added line');
  });

  it('returns diff lines when keys are added', () => {
    const baseline = JSON.stringify({ a: 1 }, null, 2);
    const current = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const lines = diffBaselines(baseline, current);
    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.includes('"b"')));
  });
});
