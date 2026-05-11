// v7.4.0 — shared types for per-stack scaffolders. Lives in its own file
// (rather than ../scaffold.ts) so that node.ts and python.ts can both import
// from it without creating a circular dependency back to the public entry
// module.

/** Supported `--stack` values. v7.6 adds 'go'; v7.7+ will add 'rust'. */
export type Stack = 'node' | 'python' | 'fastapi' | 'go';

/**
 * Stacks we can DETECT but cannot scaffold yet. Detection still warns +
 * exits 3 so the operator gets a clear "v7.7" diagnostic instead of a
 * silent fallback to Node, which would generate a wrong-language skeleton.
 */
export type UnsupportedStack = 'rust' | 'ruby';

export interface ParsedFiles {
  /** Raw paths extracted from the `## Files` section bullets. */
  paths: string[];
  /** Loosely-parsed package.json hints found anywhere in the section. */
  packageHints: {
    bin?: Record<string, string>;
    type?: 'module' | 'commonjs';
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    /**
     * Best-effort stack hint from prose ("uses fastapi", "Python 3.12",
     * "Node 22 ESM"). Used as a tie-breaker when path heuristics are
     * ambiguous between Python and FastAPI.
     */
    stackHint?: 'node' | 'python' | 'fastapi';
    /**
     * Extra Python dependency strings extracted via the narrow contract
     * documented in the spec ("Dependency hint extraction"):
     *   - explicit `dependencies: [...]` block in spec prose
     *   - backticked package names with extras (`uvicorn[standard]`)
     *   - phrase `depends on <name>`
     *
     * Stored verbatim — never version-inferred. Deduped by
     * PEP 503 normalized name in the Python scaffolder.
     */
    pythonDeps?: string[];
  };
}

export interface ScaffoldOptions {
  cwd?: string;
  specPath: string;
  /** When true, log what would happen but don't write anything. */
  dryRun?: boolean;
  /**
   * Explicit stack override. When provided, skips path-based detection
   * (but still validates the value: unknown → exit 3). v7.4.0 ships
   * 'node' | 'python' | 'fastapi'.
   */
  stack?: Stack;
}

export interface ScaffoldResult {
  filesCreated: string[];
  dirsCreated: string[];
  filesSkippedExisting: string[];
  /** Node-only metadata; Python scaffolder leaves these as 'skipped-no-ts' / 'skipped-exists'. */
  packageJsonAction: 'created' | 'merged' | 'skipped-exists';
  tsconfigAction: 'created' | 'skipped-exists' | 'skipped-no-ts';
  /** v7.4.0 — which stack was used. Useful for tests and for the CLI banner. */
  stack?: Stack;
  /** Names of files explicitly skipped because of `--stack` filtering (codex W5). */
  ignoredOtherStackFiles?: string[];
}

/** Per-stack scaffolders share this small context. */
export interface ScaffoldRunContext {
  cwd: string;
  parsed: ParsedFiles;
  dryRun: boolean;
}
