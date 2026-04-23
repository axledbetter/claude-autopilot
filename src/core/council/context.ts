const CHARS_PER_TOKEN = 4;

export function windowContext(text: string, maxTokens: number): string {
  const estimated = Math.ceil(text.length / CHARS_PER_TOKEN);
  if (estimated <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const charsDropped = text.length - maxChars;
  const marker = `<!-- [council: truncated ${charsDropped} chars] -->\n`;
  process.stderr.write(`[council] context truncated: dropped ${charsDropped} chars to fit ${maxTokens} token budget\n`);
  return marker + text.slice(charsDropped);
}
