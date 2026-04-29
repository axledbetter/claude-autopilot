// tests/migrate/alias-resolver.test.ts
//
// Note: this file will be extended in Phase 3 Task 3.1 with full resolver
// behavior tests (canonicalization, monorepo precedence, escape rejection).
// For now, just verify the alias map loads and contains the v1 entries.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = path.resolve(__dirname, '../../presets/aliases.lock.json');

describe('aliases.lock.json', () => {
  it('exists and parses as valid JSON', () => {
    const raw = fs.readFileSync(ALIASES_PATH, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.schemaVersion, 1);
    assert.ok(Array.isArray(data.aliases));
  });

  it('contains the v1 stable IDs (migrate@1, migrate.supabase@1, none@1)', () => {
    const data = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    const ids = data.aliases.map((a: { stableId: string }) => a.stableId);
    assert.ok(ids.includes('migrate@1'), `expected migrate@1 in ${ids.join(', ')}`);
    assert.ok(ids.includes('migrate.supabase@1'));
    assert.ok(ids.includes('none@1'));
  });

  it('every alias has a resolvesTo path inside skills/', () => {
    const data = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    for (const alias of data.aliases) {
      assert.ok(
        alias.resolvesTo.startsWith('skills/'),
        `alias ${alias.stableId} resolves to non-skills/ path: ${alias.resolvesTo}`,
      );
    }
  });

  it('rawAliases never collide across stable IDs', () => {
    const data = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
    const seen = new Set<string>();
    for (const alias of data.aliases) {
      for (const raw of alias.rawAliases ?? []) {
        assert.ok(!seen.has(raw), `raw alias ${raw} duplicated across stable IDs`);
        seen.add(raw);
      }
    }
  });
});
