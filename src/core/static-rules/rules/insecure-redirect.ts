import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

// Redirect calls in Next.js / Express / Node
const REDIRECT_CALL = /(?:\bredirect\s*\(|NextResponse\.redirect\s*\(|res\.redirect\s*\(|router\.push\s*\()/;

// User-controlled input sources
const USER_INPUT_SOURCES = /(?:req\.|request\.|params\.|query\.|body\.|searchParams\.|headers\.|getParam|getQuery|getSearchParam)/;

// Template interpolation of user input into redirect target
const TAINTED_REDIRECT_TEMPLATE = /`[^`]*\$\{[^}]*(?:url|redirect|return|next|callback|target|to|from|path|href|location)[^}]*\}`/i;
const TAINTED_REDIRECT_VAR       = /(?:url|redirect|returnUrl|returnTo|next|callbackUrl|target|to|from|path|href|location)\b/;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const insecureRedirectRule: StaticRule = {
  name: 'insecure-redirect',
  severity: 'warning',

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

        if (!REDIRECT_CALL.test(line)) continue;

        // Check if the redirect target is user-controlled
        const hasTaint = TAINTED_REDIRECT_TEMPLATE.test(line) || USER_INPUT_SOURCES.test(line);
        if (!hasTaint) {
          // Check if a variable with a suspicious name is passed
          const argStr = line.replace(REDIRECT_CALL, '');
          const hasRedirectVar = TAINTED_REDIRECT_VAR.test(line) && !/['"`]/.test(argStr);
          if (!hasRedirectVar) continue;
        }

        // Skip if there's obvious validation nearby (startsWith, URL constructor, allowlist)
        const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
        const hasValidation = /(?:startsWith\s*\(\s*['"]\/|new\s+URL|allowedRedirects|trustedOrigins|encodeURIComponent)/.test(context);
        if (hasValidation) continue;

        findings.push({
          id: `insecure-redirect:${file}:${i + 1}`,
          source: 'static-rules',
          severity: 'warning',
          category: 'insecure-redirect',
          file,
          line: i + 1,
          message: 'Possible open redirect: redirect target may be user-controlled',
          suggestion: 'Validate redirect targets — allow only relative paths (startsWith("/")) or an explicit allowlist of trusted origins',
          protectedPath: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return findings;
  },
};
