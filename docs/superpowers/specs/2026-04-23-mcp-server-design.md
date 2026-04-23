# guardrail MCP Server — Design

## Goal

Expose guardrail's review, scan, and fix capabilities as MCP tools so any MCP-compatible AI agent (Claude Code, Cursor, Windsurf, etc.) can call them natively without subprocess spawning.

## Architecture

`guardrail mcp` starts a stdio MCP server. The MCP client spawns it once per session; it loads the guardrail config and review adapter at startup, then handles all tool calls in-process for the lifetime of the session.

```
MCP client (Claude Code / Cursor / Windsurf / …)
        │  stdio (JSON-RPC 2.0)
        ▼
  src/cli/mcp.ts              ← entry point, adapter init, server lifecycle
        │
        ├── review_diff       → src/core/mcp/handlers/review-diff.ts
        ├── scan_files        → src/core/mcp/handlers/scan-files.ts
        ├── get_findings      → src/core/mcp/handlers/get-findings.ts
        ├── fix_finding       → src/core/mcp/handlers/fix-finding.ts
        ├── validate_fix      → src/core/mcp/handlers/validate-fix.ts
        └── get_capabilities  → src/core/mcp/handlers/get-capabilities.ts
```

### New files

| File | Responsibility |
|------|---------------|
| `src/cli/mcp.ts` | Server entry: load config, load adapter, register tools, connect stdio transport |
| `src/core/mcp/workspace.ts` | `resolveWorkspace(cwd)` — realpath + root enforcement for all tool calls |
| `src/core/mcp/run-store.ts` | Per-run finding persistence (`.guardrail-cache/runs/<run_id>.json`), read/write, cleanup |
| `src/core/mcp/concurrency.ts` | Per-workspace write lock (reads parallel, fixes serialize) |
| `src/core/mcp/handlers/review-diff.ts` | Tool handler |
| `src/core/mcp/handlers/scan-files.ts` | Tool handler |
| `src/core/mcp/handlers/get-findings.ts` | Tool handler |
| `src/core/mcp/handlers/fix-finding.ts` | Tool handler |
| `src/core/mcp/handlers/validate-fix.ts` | Tool handler |
| `src/core/mcp/handlers/get-capabilities.ts` | Tool handler |
| `src/cli/index.ts` | Add `case 'mcp':` dispatch |

### Modified files

| File | Change |
|------|--------|
| `package.json` | Add `@modelcontextprotocol/sdk` to `dependencies` |

## Path Safety

Every tool that accepts `cwd` or `files` passes them through `resolveWorkspace`:

```typescript
// src/core/mcp/workspace.ts
export function resolveWorkspace(cwd?: string): string {
  const root = fs.realpathSync(cwd ?? process.cwd());
  return root;
}

export function assertInWorkspace(workspace: string, filePath: string): string {
  const resolved = fs.realpathSync(path.resolve(workspace, filePath));
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    throw new Error(`Path "${filePath}" is outside workspace "${workspace}"`);
  }
  return resolved;
}
```

`scan_files` entries and `fix_finding` file paths all pass through `assertInWorkspace` before any I/O. Absolute paths outside the workspace are rejected.

## Run-Scoped Finding Store

`review_diff` and `scan_files` both generate a `run_id = crypto.randomUUID()` and write findings to `.guardrail-cache/runs/<run_id>.json` alongside a SHA-256 checksum of each affected file at review time.

```typescript
// .guardrail-cache/runs/<run_id>.json
{
  run_id: string,
  createdAt: string,
  findings: Finding[],
  fileChecksums: Record<string, string>  // file path → sha256 at time of review
}
```

`get_findings` and `fix_finding` require `run_id`. `fix_finding` re-checksums the target file before applying the patch and returns `{ status: 'human_required', reason: 'file_changed' }` if the checksum has drifted. Run files older than 24 hours are pruned on `review_diff`/`scan_files` startup.

## Concurrency

`src/core/mcp/concurrency.ts` maintains an in-memory map of per-workspace write locks. Read operations (`review_diff`, `scan_files`, `get_findings`, `get_capabilities`) run freely in parallel. `fix_finding` and `validate_fix` acquire an exclusive lock per workspace before executing and release it on completion or error.

## Tools

### `review_diff`

Review git-changed files against a base ref.

```typescript
input: {
  base?: string      // default: upstream branch or HEAD~1
  cwd?: string       // default: process.cwd()
  static_only?: boolean  // skip LLM review, static rules only (default: false)
}

output: {
  schema_version: 1,
  run_id: string,
  findings: Finding[],
  human_summary: string,
  usage?: { costUSD?: number }
}
```

### `scan_files`

Review arbitrary files or directories. Does not require git.

```typescript
input: {
  files: string[]    // file or directory paths (relative to cwd or absolute within workspace)
  cwd?: string
  ask?: string       // targeted question (e.g. "is there SQL injection risk here?")
}

output: {
  schema_version: 1,
  run_id: string,
  findings: Finding[],
  human_summary: string
}
```

### `get_findings`

Return findings from a prior run by `run_id`.

```typescript
input: {
  run_id: string
  severity?: 'critical' | 'warning' | 'note'  // minimum severity: 'critical' → critical only; 'warning' → warning+critical; 'note' → all
  cwd?: string
}

output: {
  schema_version: 1,
  run_id: string,
  findings: Finding[],
  cachedAt: string
}
```

### `fix_finding`

Apply an LLM-generated fix for a specific finding. Validates file checksum before applying.

```typescript
input: {
  run_id: string
  finding_id: string
  cwd?: string
  dry_run?: boolean   // return patch without applying (default: false)
}

output: {
  schema_version: 1,
  status: 'fixed' | 'reverted' | 'human_required' | 'skipped',
  reason?: string     // present when status is human_required or skipped
  patch?: string      // unified diff
  commitSha?: string  // present when status is fixed and git commit was made
  appliedFiles: string[]
}
```

Failure modes:
- `human_required` + `reason: 'file_changed'` — file checksum drifted since review
- `human_required` + `reason: 'protected_path'` — file is in a protected path
- `reverted` — patch applied but test verification failed, changes rolled back
- `skipped` — `dry_run: true`

### `validate_fix`

Run the configured `testCommand` and return structured pass/fail. No-ops (returns `{ passed: true }`) if no `testCommand` configured.

```typescript
input: {
  cwd?: string
  files?: string[]   // optional: only report failures touching these files
}

output: {
  schema_version: 1,
  passed: boolean,
  output: string,    // stdout + stderr, truncated at 4000 chars
  durationMs: number
}
```

### `get_capabilities`

Return session metadata for agent planning.

```typescript
input: {
  cwd?: string
}

output: {
  schema_version: 1,
  adapter: string,             // e.g. "claude", "gemini", "codex"
  enabledRules: string[],      // static rule IDs active in this config
  writeable: boolean,          // whether fix_finding can apply patches (always true for local)
  gitAvailable: boolean,       // whether git is available in workspace
  testCommandConfigured: boolean,
  guardrailVersion: string
}
```

## Output Format

All tools return strict JSON with a `schema_version` field. Every response includes a `human_summary` (or equivalent human-readable string) as an optional field for UX rendering — agents should parse the structured fields, not the summary.

## Registration Example

```json
{
  "mcpServers": {
    "guardrail": {
      "command": "npx",
      "args": ["guardrail", "mcp"],
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

## Error Handling

Tool errors are returned as MCP error responses (not thrown). Structured as:
```typescript
{ code: 'path_violation' | 'run_not_found' | 'adapter_error' | 'lock_timeout' | 'git_error', message: string }
```

Adapter failures (rate limit, auth) surface the `GuardrailError.code` directly.

## Testing

- Unit tests for `resolveWorkspace` / `assertInWorkspace` — path traversal, symlinks, absolute paths, boundary cases
- Unit tests for `run-store` — write, read, checksum validation, pruning, concurrent access
- Unit tests for `concurrency` — parallel reads allowed, concurrent fix_finding serialized
- Integration tests for each tool handler using injected mock adapter and mock filesystem
- Snapshot test for `get_capabilities` output shape
