// src/core/migrate/detector-rules.ts
//
// Detection rules for the init flow. Each rule has explicit confidence;
// detector returns all matches with their confidence so the UI can
// auto-select (1 high) or prompt (>1 or any non-high).

import type { CommandSpec } from './types.ts';

export type Confidence = 'high' | 'medium' | 'low';

export interface DetectionRule {
  name: string;
  stack: string;
  confidence: Confidence;
  /** All entries must exist (relative to project_root) for a match. */
  requireAll: string[];
  /** At least one entry must exist (relative to project_root). Optional. */
  requireAny?: string[];
  /** Patterns to glob for; at least one match required. Optional. */
  requireGlob?: string[];
  /** Path that, if present, disqualifies the rule (e.g. supabase-bare excluded if data/deltas/ present). */
  excludeIf?: string[];
  /** A file's content must contain this regex (e.g. Gemfile contains rails). */
  contentMatches?: { file: string; pattern: RegExp };
  defaultSkill: string;
  defaultCommand?: CommandSpec;
  /** When confidence is low/medium, prompt user before auto-selecting. */
  promptOnSelect: boolean;
}

export const DETECTION_RULES: DetectionRule[] = [
  {
    name: 'nextjs-supabase',
    stack: 'nextjs-supabase',
    confidence: 'high',
    requireAll: ['data/deltas', '.claude/supabase-envs.json'],
    defaultSkill: 'migrate.supabase@1',
    promptOnSelect: false,
  },
  {
    name: 'supabase-cli',
    stack: 'supabase-cli',
    confidence: 'high',
    requireAll: ['supabase/migrations'],
    excludeIf: ['data/deltas'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'supabase', args: ['migration', 'up'] },
    promptOnSelect: false,
  },
  {
    name: 'prisma-migrate',
    stack: 'prisma-migrate',
    confidence: 'high',
    requireAll: ['prisma/schema.prisma', 'prisma/migrations'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'prisma', args: ['migrate', 'dev'] },
    promptOnSelect: false,
  },
  {
    name: 'prisma-push',
    stack: 'prisma-push',
    confidence: 'low',
    requireAll: ['prisma/schema.prisma'],
    excludeIf: ['prisma/migrations'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'prisma', args: ['db', 'push'] },
    promptOnSelect: true,
  },
  {
    name: 'drizzle-migrate',
    stack: 'drizzle-migrate',
    confidence: 'high',
    requireAll: ['drizzle/migrations'],
    requireAny: ['drizzle.config.ts', 'drizzle.config.js'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'drizzle-kit', args: ['migrate'] },
    promptOnSelect: false,
  },
  {
    name: 'drizzle-push',
    stack: 'drizzle-push',
    confidence: 'low',
    requireAll: [],
    requireAny: ['drizzle.config.ts', 'drizzle.config.js'],
    excludeIf: ['drizzle/migrations'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'drizzle-kit', args: ['push'] },
    promptOnSelect: true,
  },
  {
    name: 'rails',
    stack: 'rails',
    confidence: 'high',
    requireAll: ['db/migrate', 'Gemfile'],
    contentMatches: { file: 'Gemfile', pattern: /\brails\b/ },
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'rails', args: ['db:migrate'] },
    promptOnSelect: false,
  },
  {
    name: 'golang-migrate',
    stack: 'golang-migrate',
    confidence: 'high',
    requireAll: ['go.mod', 'migrate'],
    defaultSkill: 'migrate@1',
    // Conventional invocation; users with non-standard layouts will edit
    // the generated stack.md (e.g. different -path or DSN flag).
    defaultCommand: { exec: 'migrate', args: ['-database', '$DATABASE_URL', '-path', 'migrations', 'up'] },
    promptOnSelect: false,
  },
  {
    name: 'flyway',
    stack: 'flyway',
    confidence: 'high',
    requireAll: [],
    requireAny: ['flyway.conf', 'flyway.toml'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'flyway', args: ['migrate'] },
    promptOnSelect: false,
  },
  {
    name: 'dbmate',
    stack: 'dbmate',
    confidence: 'high',
    requireAll: ['dbmate'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'dbmate', args: ['up'] },
    promptOnSelect: false,
  },
  {
    name: 'alembic',
    stack: 'alembic',
    confidence: 'medium',
    requireAll: ['alembic.ini'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'alembic', args: ['upgrade', 'head'] },
    promptOnSelect: true,
  },
  {
    name: 'django',
    stack: 'django',
    confidence: 'medium',
    requireAll: ['manage.py'],
    requireGlob: ['*/migrations/0001_*.py'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'python', args: ['manage.py', 'migrate'] },
    promptOnSelect: true,
  },
  {
    name: 'ecto',
    stack: 'ecto',
    confidence: 'medium',
    requireAll: ['mix.exs', 'priv/repo/migrations'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'mix', args: ['ecto.migrate'] },
    promptOnSelect: true,
  },
  {
    name: 'typeorm',
    stack: 'typeorm',
    confidence: 'medium',
    requireAll: [],
    requireAny: ['ormconfig.json', 'ormconfig.ts', 'ormconfig.js', 'data-source.ts'],
    defaultSkill: 'migrate@1',
    defaultCommand: { exec: 'typeorm', args: ['migration:run'] },
    promptOnSelect: true,
  },
  {
    name: 'supabase-bare',
    stack: 'supabase-bare',
    confidence: 'low',
    requireAll: ['supabase'],
    excludeIf: ['supabase/migrations', 'data/deltas'],
    defaultSkill: 'migrate@1',
    promptOnSelect: true,
  },
];
