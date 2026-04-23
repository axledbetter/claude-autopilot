const CHARS_PER_TOKEN = 4;

export function windowContext(text: string, maxTokens: number): string {
  const estimated = Math.ceil(text.length / CHARS_PER_TOKEN);
  if (estimated <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  // Reserve budget for the marker so the final output stays within maxTokens.
  // Use a conservative upper bound of the formatted marker (the digit count of
  // charsDropped is computed from text length to avoid circular dependency).
  const markerOverhead = `<!-- [council: truncated ${text.length} chars] -->\n`.length;
  const effectiveMaxChars = Math.max(0, maxChars - markerOverhead);
  const charsDropped = text.length - effectiveMaxChars;
  const marker = `<!-- [council: truncated ${charsDropped} chars] -->\n`;
  process.stderr.write(`[council] context truncated: dropped ${charsDropped} chars to fit ${maxTokens} token budget\n`);
  return marker + text.slice(charsDropped);
}
