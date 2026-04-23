import * as fs from 'node:fs';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

const SECRET_PATTERNS: { regex: RegExp; label: string }[] = [
  // Cloud provider keys
  { regex: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { regex: /\b(?:aws|AWS)_?(?:secret|SECRET)_?(?:key|KEY|access|ACCESS)\s*[:=]\s*['"][A-Za-z0-9/+]{40}['"]/, label: 'AWS Secret Access Key' },

  // LLM / AI providers
  { regex: /\bsk-ant-[a-zA-Z0-9\-_]{20,}\b/, label: 'Anthropic API key' },
  { regex: /\bsk-[a-zA-Z0-9]{20,}\b(?!.*placeholder)/, label: 'OpenAI API key' },
  { regex: /\bgsk_[a-zA-Z0-9]{20,}\b/, label: 'Groq API key' },

  // Payment
  { regex: /\bsk_live_[a-zA-Z0-9]{24,}\b/, label: 'Stripe secret key (live)' },
  { regex: /\brk_live_[a-zA-Z0-9]{24,}\b/, label: 'Stripe restricted key (live)' },

  // Source control / CI
  { regex: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub personal access token' },
  { regex: /\bghs_[a-zA-Z0-9]{36}\b/, label: 'GitHub Actions token' },
  { regex: /\bgithub_pat_[a-zA-Z0-9_]{82}\b/, label: 'GitHub fine-grained PAT' },

  // Communication
  { regex: /\bSG\.[a-zA-Z0-9\-_]{22,}\.[a-zA-Z0-9\-_]{43,}\b/, label: 'SendGrid API key' },
  { regex: /\bAC[a-f0-9]{32}\b/, label: 'Twilio Account SID' },

  // Database / BaaS
  { regex: /\bservice_role\b.*\beyJ[a-zA-Z0-9._-]{100,}\b/, label: 'Supabase service role JWT' },
  { regex: /\beyJ[a-zA-Z0-9._-]{150,}\b/, label: 'Long JWT (possible service key)' },

  // Generic patterns
  { regex: /(?:^|[^a-z])(?:password|passwd|pwd)\s*[:=]\s*['"](?!\/)[^'"]{6,}['"]/, label: 'Hardcoded password' },
  { regex: /(?:api_key|apikey|api-key)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded API key' },
  { regex: /(?:secret|secret_key|secretkey)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded secret' },
  { regex: /(?:access_token|accesstoken)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded access token' },
  { regex: /(?:private_key|privatekey)\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded private key' },
  { regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: 'Private key block' },
];

// Patterns that indicate a placeholder, not a real secret
const PLACEHOLDER = /(?:your[-_]?|xxx|placeholder|example|test|fake|dummy|changeme|<[^>]+>|process\.env|import\.meta\.env|\$\{)/i;
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
