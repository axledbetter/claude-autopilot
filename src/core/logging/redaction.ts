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

/**
 * Convenience wrapper around {@link applyRedaction} that defaults to the
 * built-in {@link DEFAULT_REDACTION_PATTERNS} list and accepts an optional
 * caller-supplied extension. Designed for adapter `output` fields and other
 * "last N lines" surfaces where a pattern list is rarely available at the
 * call site (the v5.6 spec § "Log redaction" requires this for all new
 * adapters).
 *
 * Pass extra patterns when the caller has loaded
 * `config.persistence.redactionPatterns`; otherwise omit the argument and
 * the defaults handle the well-known token shapes.
 */
export function redactLogLines(text: string, patterns?: readonly string[]): string {
  if (!text) return text;
  const merged = patterns && patterns.length > 0
    ? [...DEFAULT_REDACTION_PATTERNS, ...patterns]
    : DEFAULT_REDACTION_PATTERNS;
  return applyRedaction(text, merged);
}
