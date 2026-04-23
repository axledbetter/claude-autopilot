// @snapshot-for: src/formatters/sarif.ts
// @generated-at: 2026-04-21T17:42:06.431Z
// @source-commit: d207869
// @generator-version: 1.0.0-alpha.6

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { normalizeSarifUri, toSarif } from '../../src/formatters/sarif.ts';
import { normalizeSnapshot } from '../../scripts/snapshots/serializer.ts';

const SLUG = 'src-formatters-sarif';
const baselineRaw =
  process.env.CAPTURE_BASELINE === '1'
    ? '{}'
    : fs.readFileSync(
        fileURLToPath(new URL('./baselines/src-formatters-sarif.json', import.meta.url)),
        'utf8',
      );
const baseline = JSON.parse(baselineRaw);
const captured: Record<string, unknown> = {};
process.on('exit', () => {
  if (process.env.CAPTURE_BASELINE === '1') {
    const p = process.env.AUTOREGRESS_TEMP_BASELINE_DIR
      ? path.join(process.env.AUTOREGRESS_TEMP_BASELINE_DIR, 'src-formatters-sarif.json')
      : fileURLToPath(new URL('./baselines/src-formatters-sarif.json', import.meta.url));
    fs.writeFileSync(p, JSON.stringify(captured, null, 2), 'utf8');
  }
});

describe(SLUG, () => {
  it('normalizeSarifUri handles relative absolute and parent escaping paths', () => {
    const cwd = '/repo';
    const result = {
      rel: normalizeSarifUri('src/index.ts', cwd),
      absInside: normalizeSarifUri('/repo/lib/file.ts', cwd),
      absOutside: normalizeSarifUri('/other/place/file.ts', cwd),
      dotted: normalizeSarifUri('./scripts/run.ts', cwd),
      windows: normalizeSarifUri('folder\\nested\\file.ts', cwd),
    };

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['normalizeSarifUri handles relative absolute and parent escaping paths'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['normalizeSarifUri handles relative absolute and parent escaping paths']),
    );
  });

  it('toSarif emits schema tool metadata rules and mapped severities', () => {
    const runResult = {
      allFindings: [
        {
          category: 'no-secrets',
          severity: 'critical',
          message: 'Hardcoded secret detected',
          file: '/repo/src/a.ts',
          line: 10,
          suggestion: 'Use environment variables',
        },
        {
          category: 'style-warning',
          severity: 'warning',
          message: 'Potentially confusing naming',
          file: '/repo/src/b.ts',
          line: 3,
        },
        {
          category: 'info-note',
          severity: 'info',
          message: 'Informational hint',
          file: '/repo/src/c.ts',
        },
        {
          category: 'no-secrets',
          severity: 'critical',
          message: 'Another secret',
          file: '/repo/src/d.ts',
          line: 20,
        },
      ],
    } as any;

    const result = toSarif(runResult, { toolVersion: '9.9.9', cwd: '/repo' });

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['toSarif emits schema tool metadata rules and mapped severities'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['toSarif emits schema tool metadata rules and mapped severities']),
    );
  });

  it('toSarif includes optional fix and region only when provided', () => {
    const runResult = {
      allFindings: [
        {
          category: 'cat-a',
          severity: 'warning',
          message: 'Has line and suggestion',
          file: 'src/with.ts',
          line: 42,
          suggestion: 'Apply quick fix',
        },
        {
          category: 'cat-b',
          severity: 'warning',
          message: 'No line no suggestion',
          file: 'src/without.ts',
        },
      ],
    } as any;

    const result = toSarif(runResult, { toolVersion: '1.2.3', cwd: '/repo' });

    if (process.env.CAPTURE_BASELINE === '1') {
      captured['toSarif includes optional fix and region only when provided'] = result;
      return;
    }
    assert.equal(
      normalizeSnapshot(result),
      normalizeSnapshot(baseline['toSarif includes optional fix and region only when provided']),
    );
  });
});
