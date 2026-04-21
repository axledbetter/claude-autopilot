export const DEFAULT_REDACTION_PATTERNS: readonly string[] = Object.freeze([
  '\\bsk-[a-zA-Z0-9_-]{20,}',
  '\\beyJ[a-zA-Z0-9_-]{30,}',
  '\\bghp_[a-zA-Z0-9]{30,}',
  '\\bxoxb-[a-zA-Z0-9-]{20,}',
  '\\bAKIA[A-Z0-9]{16}\\b',
]);

export function applyRedaction(text: string, patterns: readonly string[]): string {
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  }
  return result;
}

export function containsSecret(text: string, patterns: readonly string[]): boolean {
  return patterns.some(p => new RegExp(p).test(text));
}
