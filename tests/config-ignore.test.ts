import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigIgnore } from '../src/core/ignore/index.ts';

describe('parseConfigIgnore', () => {
  it('returns empty for undefined', () => {
    assert.deepEqual(parseConfigIgnore(undefined), []);
  });

  it('bare string becomes wildcard rule', () => {
    const rules = parseConfigIgnore(['src/legacy/**']);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.ruleId, '*');
    assert.equal(rules[0]!.pathGlob, 'src/legacy/**');
  });

  it('object with rule + path', () => {
    const rules = parseConfigIgnore([{ rule: 'hardcoded-secrets', path: 'src/vendor/**' }]);
    assert.equal(rules[0]!.ruleId, 'hardcoded-secrets');
    assert.equal(rules[0]!.pathGlob, 'src/vendor/**');
  });

  it('object without rule defaults to wildcard', () => {
    const rules = parseConfigIgnore([{ path: 'tests/**' }]);
    assert.equal(rules[0]!.ruleId, '*');
    assert.equal(rules[0]!.pathGlob, 'tests/**');
  });

  it('handles mixed array', () => {
    const rules = parseConfigIgnore(['tests/**', { rule: 'console-log', path: 'src/**' }]);
    assert.equal(rules.length, 2);
    assert.equal(rules[0]!.ruleId, '*');
    assert.equal(rules[1]!.ruleId, 'console-log');
  });
});
