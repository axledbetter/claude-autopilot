import { minimatch } from 'minimatch';

const PROTECTED_PATTERNS = [
  '**/auth/**',
  'data/deltas/*.sql',
  '**/payment/**',
  '**/stripe/**',
  '**/encryption/**',
  '**/crypto/**',
  'lib/supabase/server-with-auth.ts',
  'lib/supabase/**',
  'app/api/**/route.ts',
  'worker/**',
  'app/api/email/ses-events/**',
  'middleware.ts',
  'utils/supabase/middleware.ts',
];

export function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATTERNS.some(pattern => minimatch(filePath, pattern));
}

