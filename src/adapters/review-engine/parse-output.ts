import type { Finding } from '../../core/findings/types.ts';

// Allowlist of code-file extensions we'll accept as a file reference. Without
// this constraint the prior regex `\.[a-z]{1,6}` matched prose abbreviations
// like "e.g" and "i.e", which is how the `fix` command broke for users — every
// finding got `file: "e.g"` and the auto-fixer matched nothing.
//
// JS regex alternation is leftmost-first, so longer alternatives MUST come
// before shorter ones — otherwise `file.cpp:42` matches `file.c` and the line
// number `:42` is silently dropped (across cpp/hpp/mdx/jsonc/dart/mm/mk/css/
// hs/cmake/coffee and more). Sorted strictly by length DESC; ties within a
// length bucket are alphabetical. Tests in claude-adapter.test.ts pin this.
const CODE_EXT = String.raw`(?:` +
  // 10
  String.raw`dockerfile|` +
  // 7
  String.raw`graphql|` +
  // 6
  String.raw`coffee|gradle|svelte|` +
  // 5
  String.raw`astro|cmake|jsonc|proto|scala|swift|` +
  // 4
  String.raw`bash|cljs|dart|fish|html|java|json|less|sass|scss|toml|yaml|` +
  // 3
  String.raw`asm|cjs|clj|cpp|css|edn|elm|env|erl|exs|fsi|fsx|gql|hcl|hpp|htm|ini|jsx|lua|mdx|mjs|mli|nim|php|sol|sql|tsx|vue|xml|yml|zig|zsh|` +
  // 2
  String.raw`cc|cs|ex|fs|go|hs|jl|js|kt|md|mk|ml|mm|pl|pm|py|rb|rs|sc|sh|tf|ts` +
  // (single-letter code extensions like c/d/h/m/r/s are intentionally NOT in
  // the bare-reference alternation: prose like "fn.r" or "lib.h" matches as
  // a "file" too easily and breaks the `fix` command. They still match when
  // explicitly backtick-wrapped — the LLM has to signal intent.)
String.raw`)`;

// Matches "path/to/file.ts:42" (bare with known ext), "`path/to/file.ts`" (any
// ext when explicitly backtick-wrapped). Backtick-wrapped accepts any extension
// because the LLM signaled intent; bare paths must be a recognized code file.
const FILE_REF = new RegExp(
  String.raw`(?:` +
    String.raw`\x60([^\x60]+\.[a-z]{1,6})\x60` +
    String.raw`|(\b[\w./\-]+\.` + CODE_EXT + String.raw`)(?::(\d+))?` +
  String.raw`)`,
  'i',
);

// Matches "line 42", "on line 42", "at line 42" — used as a fallback when the
// LLM mentions a line number separately from the file ref. Critical for `fix`:
// without a line, the fixer can't extract a code snippet, so findings without
// `line` got silently dropped from `fix --dry-run` (the path-only finding case
// was the most-cited demo torpedo from the 5.0.7 stress test).
const LINE_REF = /\b(?:on |at )?line\s+(\d+)\b/i;

function extractFileRef(text: string): { file: string; line?: number } {
  const m = text.match(FILE_REF);
  if (!m) {
    // No file ref at all — but maybe the body still has "line N" prose we can
    // surface. Caller treats file `<unspecified>` as a sentinel either way.
    const lm = text.match(LINE_REF);
    return lm ? { file: '<unspecified>', line: parseInt(lm[1]!, 10) } : { file: '<unspecified>' };
  }
  const raw = (m[1] ?? m[2])!;
  // Skip version strings (v1.2.3), bare dotfile extensions with no path
  // separator, and known prose abbreviations that slipped through the regex
  // (only applicable when backtick-wrapped, since the bare branch already
  // requires a known code extension).
  if (
    /^v?\d/.test(raw) ||
    (!raw.includes('/') && raw.startsWith('.') && raw.split('.').length === 2) ||
    /^(?:e\.g|i\.e|etc|vs|cf|al|U\.S|U\.K)$/i.test(raw)
  ) {
    const lm = text.match(LINE_REF);
    return lm ? { file: '<unspecified>', line: parseInt(lm[1]!, 10) } : { file: '<unspecified>' };
  }
  // Prefer the colon-line from the file ref (`foo.ts:42`); fall back to a
  // separately-mentioned line ("line 42") only when the file ref didn't carry one.
  const colonLine = m[3] ? parseInt(m[3], 10) : undefined;
  if (colonLine !== undefined) return { file: raw, line: colonLine };
  const lm = text.match(LINE_REF);
  return lm ? { file: raw, line: parseInt(lm[1]!, 10) } : { file: raw };
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
