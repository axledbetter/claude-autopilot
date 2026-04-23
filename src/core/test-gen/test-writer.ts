import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoverageGap } from './coverage-analyzer.ts';

export function writeGeneratedTest(gap: CoverageGap, generatedCode: string): string {
  const dir = path.dirname(gap.testFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(gap.testFile, generatedCode, 'utf8');
  return gap.testFile;
}

export function buildGenerationPrompt(gap: CoverageGap, sourceContent: string, framework: string): string {
  const relPath = gap.file;
  const exports = gap.exports.join(', ');
  return `Generate a complete test file for the following TypeScript module.

Source file: ${relPath}
Uncovered exports: ${exports}
Test framework: ${framework}

Source code:
\`\`\`typescript
${sourceContent.slice(0, 4000)}
\`\`\`

Requirements:
- Import the exports from "${relPath}" using a relative path
- Write one describe block per export
- Include a happy-path test and at least one edge case per export
- Use ${framework === 'node:test' ? "import { describe, it } from 'node:test'; import assert from 'node:assert/strict';" : `import { describe, it, expect } from '${framework}';`}
- Do NOT use mocks unless the function clearly requires external I/O
- Output ONLY the test file contents, no explanation`;
}
