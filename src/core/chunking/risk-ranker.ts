import { minimatch } from 'minimatch';

interface RankOptions {
  protectedPaths?: string[];
}

const AUTH_PATTERNS = [
  /auth/i, /login/i, /logout/i, /session/i, /token/i, /jwt/i, /oauth/i,
  /password/i, /credential/i, /secret/i, /permission/i, /role/i, /acl/i,
];

const PAYMENT_PATTERNS = [
  /payment/i, /billing/i, /stripe/i, /checkout/i, /invoice/i, /charge/i,
  /subscription/i, /wallet/i, /transaction/i, /refund/i,
];

const CORE_PATTERNS = [
  /\/services\//i, /\/core\//i, /\/api\//i, /\/routes?\//i,
  /\/controllers?\//i, /\/models?\//i, /\/middleware\//i, /\/handlers?\//i,
];

const TEST_EXT = /\.(test|spec)\.[a-z]+$/i;
const DOC_EXT = /\.(md|txt|rst|adoc)$/i;
const CONFIG_EXT = /\.(ya?ml|json|toml|ini|env)$/i;
const CONFIG_NAMES = /(config|settings|env|constants)\./i;

function scoreFile(file: string, protectedPaths: string[]): number {
  const norm = file.replace(/\\/g, '/');

  // Protected paths are highest risk
  for (const pattern of protectedPaths) {
    if (minimatch(norm, pattern, { matchBase: false }) ||
        minimatch(norm, pattern, { matchBase: true })) {
      return 100;
    }
  }

  if (TEST_EXT.test(norm)) return 10;
  if (DOC_EXT.test(norm)) return 5;

  if (AUTH_PATTERNS.some(p => p.test(norm))) return 80;
  if (PAYMENT_PATTERNS.some(p => p.test(norm))) return 70;
  if (CORE_PATTERNS.some(p => p.test(norm))) return 50;
  if (CONFIG_EXT.test(norm) || CONFIG_NAMES.test(norm)) return 40;

  return 30;
}

/**
 * Returns files sorted highest-risk first so LLM sees the most sensitive code
 * at the start of its context window.
 */
export function rankByRisk(files: string[], options: RankOptions = {}): string[] {
  const protectedPaths = options.protectedPaths ?? [];
  return [...files].sort((a, b) => scoreFile(b, protectedPaths) - scoreFile(a, protectedPaths));
}
