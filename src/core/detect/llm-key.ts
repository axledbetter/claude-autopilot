/**
 * Shared LLM API key detection. Used by setup, doctor/preflight, scan, and run so
 * every surface agrees on which env vars count as "have a key."
 *
 * Before this unified helper, doctor only checked ANTHROPIC_API_KEY + OPENAI_API_KEY
 * while setup/scan/run checked all 5 providers — producing contradictory messages
 * ("LLM API key: detected" from setup, "No LLM API key" from doctor moments later).
 */

import * as fs from 'node:fs';

/** All env var names guardrail recognizes as LLM API keys, ordered by preference. */
export const LLM_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
] as const;

export type LLMKeyName = typeof LLM_KEY_NAMES[number];

export interface KeyDetectionOptions {
  /** Additional key→value map to check alongside process.env (e.g. parsed .env.local). */
  extraEnv?: Record<string, string | undefined>;
}

export interface KeyDetectionResult {
  /** True if any recognized LLM key is set to a non-empty value. */
  hasKey: boolean;
  /** Preferred key that was detected, or null. Follows LLM_KEY_NAMES order. */
  preferred: LLMKeyName | null;
  /** All keys that were detected, in LLM_KEY_NAMES order. */
  detected: LLMKeyName[];
}

function readEnvFileSync(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* ignore */
  }
  return vars;
}

/** Load an env file into a plain object without mutating process.env. */
export function loadEnvFile(filePath: string): Record<string, string> {
  return readEnvFileSync(filePath);
}

/** Detect whether any recognized LLM API key is set. */
export function detectLLMKey(options: KeyDetectionOptions = {}): KeyDetectionResult {
  const extra = options.extraEnv ?? {};
  const detected: LLMKeyName[] = [];
  for (const name of LLM_KEY_NAMES) {
    const value = process.env[name] ?? extra[name];
    if (value && value.length > 0) detected.push(name);
  }
  return {
    hasKey: detected.length > 0,
    preferred: detected[0] ?? null,
    detected,
  };
}

/** Human-readable list of providers and signup URLs, used by every "no key" message. */
export const LLM_KEY_HINTS: Array<{ name: LLMKeyName; url: string; note?: string }> = [
  { name: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com/' },
  { name: 'OPENAI_API_KEY',    url: 'https://platform.openai.com/api-keys' },
  { name: 'GEMINI_API_KEY',    url: 'https://aistudio.google.com/app/apikey' },
  { name: 'GROQ_API_KEY',      url: 'https://console.groq.com/keys', note: 'fast free tier' },
];
