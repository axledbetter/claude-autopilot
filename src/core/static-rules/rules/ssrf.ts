import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

// HTTP client calls
const HTTP_CALL = /\b(?:fetch|axios\.get|axios\.post|axios\.put|axios\.delete|axios\.request|axios\s*\(|http\.get|https\.get|http\.request|https\.request|got\s*\(|needle\.get|superagent\.get|request\s*\()\s*\(/;

// User-controlled input sources
const USER_INPUT = /(?:req\.|request\.|params\.|query\.|body\.|searchParams\.|headers\.|url\b|getParam|getQuery|getHeader)/;

// Template literal or concatenation with a user-controlled value followed by URL context
const TAINTED_URL_TEMPLATE = /`[^`]*\$\{[^}]*(?:req|params|query|body|url|host|origin|domain|endpoint|target)[^}]*\}[^`]*`/i;
const TAINTED_URL_CONCAT   = /(?:req|params|query|body|url|host|origin|domain|endpoint|target)\s*[+]/i;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const ssrfRule: StaticRule = {
  name: 'ssrf',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (!CODE_EXTS.has(ext) || TEST_PATH.test(file)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        const isHttpCall = HTTP_CALL.test(line);
        if (!isHttpCall) continue;

        // Check if the argument contains user-controlled input
        const hasTaint = TAINTED_URL_TEMPLATE.test(line) || TAINTED_URL_CONCAT.test(line) || USER_INPUT.test(line);
        if (!hasTaint) continue;

        // Skip if there's obvious URL validation on nearby lines (allowlist, startsWith, etc.)
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        const hasValidation = /(?:allowlist|allowedOrigins|trustedDomains|startsWith|includes\s*\(\s*['"]https:\/\/|new\s+URL\s*\()/.test(context);
        if (hasValidation) continue;

        findings.push({
          id: `ssrf:${file}:${i + 1}`,
          source: 'static-rules',
          severity: 'critical',
          category: 'ssrf',
          file,
          line: i + 1,
          message: 'Possible SSRF: HTTP request URL appears to be derived from user input',
          suggestion: 'Validate the URL against an allowlist of trusted domains before making the request',
          protectedPath: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return findings;
  },
};
