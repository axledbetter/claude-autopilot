import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const SECRET_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { regex: /(?:^|[^a-z])(?:password|passwd|pwd)\s*[:=]\s*['"](?!\/)[^'"]{6,}['"]/, label: 'Hardcoded password' },
  { regex: /(?:api_key|apikey|api-key)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded API key' },
  { regex: /(?:secret|secret_key|secretkey)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded secret' },
  { regex: /(?:access_token|accesstoken)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded access token' },
  { regex: /(?:private_key|privatekey)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded private key' },
  { regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: 'Private key block' },
];

// Patterns that indicate a placeholder, not a real secret
const PLACEHOLDER = /(?:your[-_]?|xxx|placeholder|example|test|fake|dummy|changeme|<[^>]+>)/i;
const SKIP_EXTS = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.lock', '.snap']);
const TEST_PATH = /(?:__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/)/;

export const hardcodedSecretsRule: StaticRule = {
  name: 'hardcoded-secrets',
  severity: 'critical',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of touchedFiles) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (SKIP_EXTS.has(ext) || TEST_PATH.test(file)) continue;
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith('//') || line.trim().startsWith('#')) continue;
        for (const { regex, label } of SECRET_PATTERNS) {
          const match = line.match(regex);
          if (match && !PLACEHOLDER.test(match[0])) {
            findings.push({
              id: `hardcoded-secrets:${file}:${i + 1}`,
              source: 'static-rules',
              severity: 'critical',
              category: 'hardcoded-secrets',
              file,
              line: i + 1,
              message: `${label} appears hardcoded`,
              suggestion: 'Move to environment variable and load via process.env',
              protectedPath: false,
              createdAt: new Date().toISOString(),
            });
            break;
          }
        }
      }
    }
    return findings;
  },
};
