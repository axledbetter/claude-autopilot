import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

// Next.js App Router API routes and pages with data mutations
const API_ROUTE_PATTERN = /(?:app[/\\]api[/\\].*route\.[tj]sx?|pages[/\\]api[/\\].*\.[tj]sx?)$/;

// Auth function signatures — any of these indicate auth is checked
const AUTH_PATTERNS = [
  /getServerSession\s*\(/,
  /\bauth\s*\(\s*\)/,           // next-auth v5 auth()
  /createServerSupabase\s*\(/,
  /createServerClient\s*\(/,
  /getSession\s*\(/,
  /verifyToken\s*\(/,
  /authenticate\s*\(/,
  /requireAuth\s*\(/,
  /currentUser\s*\(/,
  /withAuth\s*\(/,
  /checkAuth\s*\(/,
  /isAuthenticated\s*\(/,
  /useServerSession\s*\(/,
  /jwtVerify\s*\(/,
  /verify\s*\(.*token/i,
  /clerkClient/,
  /getAuth\s*\(/,               // Clerk
  /session\s*\.\s*user/,
  /req\s*\.\s*user\b/,
];

// Mutation handler exports — GET-only routes are less critical
const MUTATION_EXPORT = /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/;
const MUTATION_HANDLER = /(?:POST|PUT|PATCH|DELETE)\s*\(/;

export const missingAuthRule: StaticRule = {
  name: 'missing-auth',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      if (!API_ROUTE_PATTERN.test(file)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

      // Only flag mutation handlers
      if (!MUTATION_EXPORT.test(content) && !MUTATION_HANDLER.test(content)) continue;

      // Check if any auth pattern is present in the file
      const hasAuth = AUTH_PATTERNS.some(p => p.test(content));
      if (hasAuth) continue;

      const rel = path.basename(file);
      findings.push({
        id: `missing-auth:${file}:1`,
        source: 'static-rules',
        severity: 'critical',
        category: 'missing-auth',
        file,
        line: 1,
        message: `API route ${rel} has mutation handlers (POST/PUT/PATCH/DELETE) with no visible auth check`,
        suggestion: 'Add authentication: call getServerSession(), auth(), or equivalent before processing the request body',
        protectedPath: false,
        createdAt: new Date().toISOString(),
      });
    }
    return findings;
  },
};
