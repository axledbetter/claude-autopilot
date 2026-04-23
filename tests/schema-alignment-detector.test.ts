// tests/schema-alignment-detector.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('schema-alignment detector', () => {
  it('matches supabase data/deltas SQL file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/data/deltas/20260423_add_status.sql', '/project/app/api/users/route.ts'];
    assert.deepEqual(detect(files), ['/project/data/deltas/20260423_add_status.sql']);
  });

  it('matches supabase/migrations SQL file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/supabase/migrations/20260423_init.sql'];
    assert.deepEqual(detect(files), ['/project/supabase/migrations/20260423_init.sql']);
  });

  it('matches prisma/schema.prisma', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/prisma/schema.prisma'];
    assert.deepEqual(detect(files), ['/project/prisma/schema.prisma']);
  });

  it('matches prisma/migrations SQL', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/prisma/migrations/20260423_add_col.sql'];
    assert.deepEqual(detect(files), ['/project/prisma/migrations/20260423_add_col.sql']);
  });

  it('matches db/migrate Rails file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/db/migrate/20260423_add_status.rb'];
    assert.deepEqual(detect(files), ['/project/db/migrate/20260423_add_status.rb']);
  });

  it('does not match non-migration ts file', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/app/api/users/route.ts'];
    assert.deepEqual(detect(files), []);
  });

  it('returns empty when enabled:false', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/data/deltas/20260423_add_status.sql'];
    assert.deepEqual(detect(files, { enabled: false }), []);
  });

  it('appends config migrationGlobs to auto-detected set', async () => {
    const { detect } = await import('../src/core/schema-alignment/detector.ts');
    const files = ['/project/custom/schema/v1.sql'];
    assert.deepEqual(
      detect(files, { migrationGlobs: ['custom/schema/**/*.sql'] }),
      ['/project/custom/schema/v1.sql'],
    );
  });
});
