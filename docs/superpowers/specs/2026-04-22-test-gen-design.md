# Test Generation Design

## Goal

`guardrail test-gen` detects exported functions in changed/specified files that have no corresponding test coverage, then uses the review engine LLM to generate test cases for them. Closes the loop between "guardrail flags missing tests" and "guardrail fixes missing tests."

## Design

### Commands

```bash
guardrail test-gen                    # analyze git-changed files, generate tests for gaps
guardrail test-gen src/auth/login.ts  # target specific file
guardrail test-gen --dry-run          # show gaps without generating
guardrail test-gen --verify           # run generated tests, revert if they fail
guardrail test-gen --base main        # diff against branch (like guardrail run)
```

### Coverage analysis

Scans each file for exported functions/classes/const arrow functions using regex. For each export, checks whether any test file imports from that path or references the export name. Reports uncovered exports as gaps.

File extension heuristics for test file location:
- `src/auth/login.ts` → `src/auth/login.test.ts`, `src/auth/__tests__/login.test.ts`, `tests/auth/login.test.ts`

### LLM generation

For each uncovered export:
1. Reads the function signature + body (up to 200 lines of context)
2. Sends to review engine with prompt: "Generate a complete test file for this function using the project's test framework. Include edge cases and the happy path."
3. Detects test framework from `package.json` devDependencies (`jest`, `vitest`, `node:test`)
4. Writes generated test to the most appropriate location

### Verify mode

When `--verify` is set and `testCommand` is configured:
- After writing generated test, runs `testCommand`
- If tests fail, deletes the generated file and reports the gap as unfixable
- Same pattern as `guardrail fix --verify`

### Output

```
[test-gen] Analyzing 3 files...
  src/auth/login.ts        2 exports, 0 covered → generating
  src/auth/session.ts      1 export,  1 covered → skip
  src/db/queries.ts        3 exports, 0 covered → generating

[test-gen] Generated:
  src/auth/login.test.ts     (2 test cases)
  src/db/queries.test.ts     (3 test cases)
```

## Architecture

- `src/cli/test-gen.ts` — `runTestGen(options)` orchestrates the pipeline
- `src/core/test-gen/coverage-analyzer.ts` — `findCoverageGaps(files)` → `CoverageGap[]`
- `src/core/test-gen/framework-detector.ts` — `detectTestFramework(cwd)` → `'jest'|'vitest'|'node:test'`
- `src/core/test-gen/test-writer.ts` — `writeGeneratedTest(gap, generatedCode, cwd)` → file path
- `src/cli/index.ts` — add `test-gen` subcommand
- `tests/test-gen.test.ts` — unit tests for coverage analysis + framework detection

## Out of Scope

- TypeScript AST parsing (regex-based export detection only for v1)
- Class method coverage
- Branch/line coverage analysis (only export-level)
- Integration with Jest/Istanbul coverage reports
