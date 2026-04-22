import * as fs from 'node:fs';
import * as path from 'node:path';

interface MigrationSignal {
  glob: string;
  check: (cwd: string) => boolean;
}

const MIGRATION_SIGNALS: MigrationSignal[] = [
  { glob: 'data/deltas/**',           check: c => fs.existsSync(path.join(c, 'data', 'deltas')) },
  { glob: 'migrations/**',            check: c => fs.existsSync(path.join(c, 'migrations')) },
  { glob: 'db/migrate/**',            check: c => fs.existsSync(path.join(c, 'db', 'migrate')) },
  { glob: 'database/migrations/**',   check: c => fs.existsSync(path.join(c, 'database', 'migrations')) },
  { glob: 'prisma/migrations/**',     check: c => fs.existsSync(path.join(c, 'prisma', 'migrations')) },
  { glob: 'alembic/versions/**',      check: c => fs.existsSync(path.join(c, 'alembic', 'versions')) },
  { glob: 'flyway/**',                check: c => fs.existsSync(path.join(c, 'flyway')) },
  // *.sql is handled below via readdirSync
];

const SCHEMA_FILES = [
  'prisma/schema.prisma',
  'schema.prisma',
  'schema.sql',
  'db/schema.rb',
  'config/schema.xml',
];

const INFRA_SIGNALS: Array<{ glob: string; check: (cwd: string) => boolean }> = [
  { glob: 'terraform/**',      check: c => fs.existsSync(path.join(c, 'terraform')) },
  { glob: 'infra/**',          check: c => fs.existsSync(path.join(c, 'infra')) },
  { glob: '.github/workflows/**', check: c => fs.existsSync(path.join(c, '.github', 'workflows')) },
  { glob: 'k8s/**',            check: c => fs.existsSync(path.join(c, 'k8s')) },
  { glob: 'helm/**',           check: c => fs.existsSync(path.join(c, 'helm')) },
];

/**
 * Scans the project for migration directories, schema files, and infra configs
 * and returns glob patterns suitable for `protectedPaths`.
 */
export function detectProtectedPaths(cwd: string): string[] {
  const found = new Set<string>();

  for (const sig of MIGRATION_SIGNALS) {
    if (sig.check(cwd)) found.add(sig.glob);
  }

  // Root-level .sql files
  try {
    if (fs.readdirSync(cwd).some(f => f.endsWith('.sql'))) found.add('*.sql');
  } catch { /* ignore */ }

  for (const rel of SCHEMA_FILES) {
    if (fs.existsSync(path.join(cwd, rel))) {
      found.add(rel.includes('/') ? rel.split('/')[0] + '/**' : rel);
    }
  }

  for (const sig of INFRA_SIGNALS) {
    if (sig.check(cwd)) found.add(sig.glob);
  }

  return Array.from(found).sort();
}
