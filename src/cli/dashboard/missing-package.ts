// src/cli/dashboard/missing-package.ts
//
// Disambiguate "user needs to install <pkg>" from "transitive dep of <pkg> is
// missing." When `@supabase/supabase-js` is lazy-loaded with `await import()`
// and the package itself isn't installed, Node throws an ERR_MODULE_NOT_FOUND
// whose specifier is the package name. If a transitive dep is missing instead
// (e.g. `@supabase/postgrest-js`), the specifier will be the transitive name —
// we should NOT instruct the user to install supabase in that case.
//
// Used by dashboard upload (the only feature reachable from the CLI that
// requires `@supabase/supabase-js`). Moved to `optionalDependencies` in v7.8.0
// so local-only `npm install --omit=optional` users can skip it.

export interface MissingPackageOpts {
  /**
   * Whether to also match CommonJS-style `Cannot find module '<pkg>'`
   * messages in addition to the ESM-style `Cannot find package '<pkg>'`.
   *
   * Default **true**. Node's error format depends on the loader path
   * (ESM vs CJS) — `import()` of a missing package can surface either
   * depending on the consumer's module type and how the dep is loaded
   * by the runtime. Accepting both is the safer default for our
   * install-hint surface: a false negative here means the user sees a
   * raw `ERR_MODULE_NOT_FOUND` instead of the actionable hint.
   *
   * Set to `false` to require ESM form specifically (used by the
   * standalone `extractMissingSpecifier` helper in some tests).
   */
  acceptCjsForm?: boolean;
}

/**
 * Returns true iff `err` is a "module/package not found" error whose missing
 * specifier matches `pkgName` exactly. Transitive misses (specifier !==
 * pkgName) return false so we don't falsely advise the user to install
 * `pkgName` when something `pkgName` itself depends on is broken.
 */
export function isMissingOptionalPackageError(
  err: unknown,
  pkgName: string,
  opts: MissingPackageOpts = {},
): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND') {
    return false;
  }
  const specifier = extractMissingSpecifier(e.message, opts.acceptCjsForm ?? true);
  return specifier === pkgName;
}

/**
 * Extract the missing specifier from a Node module-not-found message.
 *
 *   ESM: "Cannot find package '<pkg>' imported from <url>"
 *   CJS: "Cannot find module '<pkg>'"
 *
 * Returns `undefined` if no specifier can be extracted (the message format
 * may shift across Node versions; caller treats this as "not our package").
 */
export function extractMissingSpecifier(
  msg: string,
  acceptCjsForm = true,
): string | undefined {
  const esm = msg.match(/Cannot find package '([^']+)'/);
  if (esm) return esm[1];
  if (acceptCjsForm) {
    const cjs = msg.match(/Cannot find module '([^']+)'/);
    if (cjs) return cjs[1];
  }
  return undefined;
}

/**
 * Standard install-hint error message for `@supabase/supabase-js`. Shared by
 * dashboard upload and the omit-optional smoke test so the assertion string
 * stays in one place.
 */
export const SUPABASE_INSTALL_HINT =
  'Dashboard upload requires @supabase/supabase-js. Install with: npm install @supabase/supabase-js';

/**
 * Probe that lazy-loads `@supabase/supabase-js`. Returns the imported module
 * on success. Throws an Error with `SUPABASE_INSTALL_HINT` if the package is
 * not installed; re-throws everything else (transitive failures, syntax
 * errors, etc.) so they aren't misclassified.
 */
export async function loadSupabaseOrInstallHint(): Promise<typeof import('@supabase/supabase-js')> {
  try {
    // Suppress TS error when `@supabase/supabase-js` isn't installed in
    // smoke-test environments — the failure surface is exactly what we're
    // probing for, and the static type-only side is fine because callers
    // who care about the typed shape import `type { ... }` separately.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await import('@supabase/supabase-js' as any)) as typeof import('@supabase/supabase-js');
  } catch (err) {
    if (isMissingOptionalPackageError(err, '@supabase/supabase-js')) {
      throw new Error(SUPABASE_INSTALL_HINT);
    }
    throw err;
  }
}
