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

/**
 * Parses the structured [CRITICAL|WARNING|NOTE] markdown format
 * produced by all review engine adapters. Extracts file:line references
 * from the finding body when present.
 */
export function parseReviewOutput(output: string, idPrefix: string): Finding[] {
  const findings: Finding[] = [];
  const regex = /### \[(CRITICAL|WARNING|NOTE)\]\s*(.+?)(?=\n### \[|## Review Summary|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
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
  return findings;
}
