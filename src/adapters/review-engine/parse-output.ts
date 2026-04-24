import type { Finding } from '../../core/findings/types.ts';

// Matches "path/to/file.ts:42", "`path/to/file.ts`", or bare filenames with common extensions
const FILE_REF = /(?:`([^`]+\.[a-z]{1,6})`|(\b[\w./\-]+\.[a-z]{1,6})(?::(\d+))?)/;

function extractFileRef(text: string): { file: string; line?: number } {
  const m = text.match(FILE_REF);
  if (!m) return { file: '<unspecified>' };
  const raw = (m[1] ?? m[2])!;
  // Skip version strings (v1.2.3) and bare dotfile extensions with no path separator
  if (/^v?\d/.test(raw) || (!raw.includes('/') && raw.startsWith('.') && raw.split('.').length === 2)) {
    return { file: '<unspecified>' };
  }
  const line = m[3] ? parseInt(m[3], 10) : undefined;
  return { file: raw, line };
}

// Accepts any of: `### [CRITICAL] title`, `### CRITICAL title`, `### **CRITICAL** title`,
// `### **[CRITICAL]** title`. Severity capture works across variants.
const FINDING_REGEX =
  /### (?:\*\*)?\[?(CRITICAL|WARNING|NOTE)\]?(?:\*\*)?\s*(.+?)(?=\n### (?:\*\*)?\[?(?:CRITICAL|WARNING|NOTE)\]?|## Review Summary|$)/gs;

// "Substantive" output = enough non-whitespace chars to be a real LLM response, not
// an empty/placeholder string. Anything past this with zero parsed findings is likely
// format drift we should warn about.
const NONTRIVIAL_OUTPUT_THRESHOLD = 40;

/**
 * Parses the structured CRITICAL|WARNING|NOTE markdown format produced by all review
 * engine adapters. Extracts file:line references from the finding body when present.
 *
 * Tolerates common LLM format drift (missing brackets, bold wrappers) because the prompt
 * alone doesn't guarantee literal `### [CRITICAL]` — models routinely emit
 * `### CRITICAL` or `### **CRITICAL**`. A strict parser silently returns zero findings
 * on otherwise-valid output, which is exactly the silent-failure mode this file exists to
 * prevent.
 */
export function parseReviewOutput(output: string, idPrefix: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of output.matchAll(FINDING_REGEX)) {
    const severity = match[1]!.toLowerCase() as Finding['severity'];
    const body = match[2]!.trim();
    const titleEnd = body.indexOf('\n');
    const title = (titleEnd > 0 ? body.slice(0, titleEnd) : body).trim();
    const suggestion = body.match(/\*\*Suggestion:\*\*\s*(.+)/s)?.[1]?.trim();
    const { file, line } = extractFileRef(body);
    findings.push({
      id: `${idPrefix}-${findings.length}`,
      source: 'review-engine',
      severity,
      category: 'review-engine',
      file,
      line,
      message: title,
      suggestion,
      protectedPath: false,
      createdAt: new Date().toISOString(),
    });
  }

  if (findings.length === 0) {
    const nonWhitespace = output.replace(/\s/g, '').length;
    if (nonWhitespace >= NONTRIVIAL_OUTPUT_THRESHOLD) {
      const preview = output.slice(0, 200).replace(/\s+/g, ' ').trim();
      // eslint-disable-next-line no-console
      console.warn(
        `[parseReviewOutput] LLM returned ${output.length} chars but no findings parsed. ` +
        `Expected '### [CRITICAL|WARNING|NOTE] …'. Preview: ${preview}${output.length > 200 ? '…' : ''}`,
      );
    }
  }

  return findings;
}
