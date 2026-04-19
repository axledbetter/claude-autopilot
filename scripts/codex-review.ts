import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { loadEnv } from './load-env';

loadEnv();

const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex';
const MAX_OUTPUT_TOKENS = 4096;

// Load the project's stack description from .autopilot/stack.md if present, else a generic fallback.
// Override per-project for stack-aware reviews.
function loadStackDescription(): string {
  const stackFile = path.resolve(process.cwd(), '.autopilot', 'stack.md');
  if (fs.existsSync(stackFile)) return fs.readFileSync(stackFile, 'utf8').trim();
  return 'A web application — stack details unspecified. If your findings depend on stack assumptions, state them explicitly in the review.';
}

const SYSTEM_PROMPT = `You are a senior software architect providing feedback on designs, proposals, and ideas.

The codebase context:
${loadStackDescription()}

Provide structured feedback in exactly this format:

## Review Summary
One paragraph overall assessment.

## Findings

For each finding, use this format:
### [CRITICAL|WARNING|NOTE] <short title>
<explanation with specific references to the content>
**Suggestion:** <actionable fix>

Rules:
- CRITICAL: Blocks implementation, will cause bugs/security issues/data loss
- WARNING: Should address before implementing, risk of problems
- NOTE: Improvement suggestion, nice to have
- Maximum 10 findings, ranked by severity (CRITICAL first)
- Be specific — reference sections, field names, or code patterns
- Be constructive, not nitpicky — skip formatting/typo issues
- If the content is solid, say so and give fewer findings`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If stdin is a TTY (no piped data), resolve empty after a short delay
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

async function main() {
  const filePath = process.argv[2];
  const textArg = process.argv.find(a => a.startsWith('--text='));

  let content: string;
  let label: string;

  if (filePath && !filePath.startsWith('--') && fs.existsSync(filePath)) {
    // Mode 1: File path
    content = fs.readFileSync(filePath, 'utf8');
    const fileName = filePath.split('/').pop();
    const docType = filePath.includes('/specs/') ? 'design spec' : filePath.includes('/plans/') ? 'implementation plan' : 'document';
    label = `${docType} "${fileName}"`;
  } else if (textArg) {
    // Mode 2: Inline text via --text="..."
    content = textArg.slice('--text='.length);
    label = 'inline text';
  } else {
    // Mode 3: Stdin
    content = await readStdin();
    if (!content.trim()) {
      console.error('Usage:');
      console.error('  npx tsx scripts/codex-review.ts <path-to-file>');
      console.error('  npx tsx scripts/codex-review.ts --text="your design proposal here"');
      console.error('  echo "your text" | npx tsx scripts/codex-review.ts');
      process.exit(1);
    }
    label = 'piped input';
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  console.error(`  Sending ${label} to ${CODEX_MODEL} for review...`);

  const client = new OpenAI({ apiKey });

  // Codex models use the responses API, not chat completions
  const response = await client.responses.create({
    model: CODEX_MODEL,
    instructions: SYSTEM_PROMPT,
    input: `Please review the following:\n\n---\n\n${content}`,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });

  const review = response.output_text;

  if (!review) {
    console.error('  No review generated');
    process.exit(0);
  }

  // Print usage info to stderr
  if (response.usage) {
    const input = response.usage.input_tokens;
    const output = response.usage.output_tokens;
    console.error(`  Tokens: ${input} input, ${output} output`);
  }

  // Print review to stdout
  console.log(review);
}

main().catch((err) => {
  console.error(`  Codex review failed: ${err.message}`);
  // Non-blocking — exit 0 even on failure
  process.exit(0);
});
