import type { StaticRule } from '../phases/static-rules.ts';
import type { StaticRuleReference } from '../config/types.ts';
import { resolveSiblingModule } from '../../cli/_pkg-root.ts';

// Dynamic-import string literals that end in `.ts` are NOT rewritten by tsc's
// `rewriteRelativeImportExtensions`. resolveSiblingModule swaps `.ts` → `.js`
// when the caller is itself compiled, so these imports resolve correctly under
// both source (`tsx`) and compiled (`node dist/...`) layouts.
const importRule = <T>(ref: string, exportName: string): Promise<StaticRule> =>
  import(resolveSiblingModule(ref, import.meta.url)).then((m: Record<string, T>) => m[exportName] as unknown as StaticRule);

// Built-in cross-stack rules
const BUILTIN: Record<string, () => Promise<StaticRule>> = {
  'hardcoded-secrets':  () => importRule('./rules/hardcoded-secrets.ts', 'hardcodedSecretsRule'),
  'npm-audit':          () => importRule('./rules/npm-audit.ts', 'npmAuditRule'),
  'package-lock-sync':  () => importRule('./rules/package-lock-sync.ts', 'packageLockSyncRule'),
  'console-log':        () => importRule('./rules/console-log.ts', 'consoleLogRule'),
  'todo-fixme':         () => importRule('./rules/todo-fixme.ts', 'todoFixmeRule'),
  'large-file':         () => importRule('./rules/large-file.ts', 'largeFileRule'),
  'missing-tests':      () => importRule('./rules/missing-tests.ts', 'missingTestsRule'),
  // Security rules
  'sql-injection':      () => importRule('./rules/sql-injection.ts', 'sqlInjectionRule'),
  'missing-auth':       () => importRule('./rules/missing-auth.ts', 'missingAuthRule'),
  'ssrf':               () => importRule('./rules/ssrf.ts', 'ssrfRule'),
  'insecure-redirect':  () => importRule('./rules/insecure-redirect.ts', 'insecureRedirectRule'),
  // Brand rules
  'brand-tokens':       () => importRule('./rules/brand-tokens.ts', 'brandTokensRule'),
  // Schema alignment
  'schema-alignment':   () => importRule('./rules/schema-alignment.ts', 'schemaAlignmentRule'),
};

// Preset-specific rules registered by name
const PRESET: Record<string, () => Promise<StaticRule>> = {
  'supabase-rls-bypass':  () => importRule('../../../presets/nextjs-supabase/rules/supabase-rls-bypass.ts', 'supabaseRlsBypassRule'),
  'go-sql-injection':     () => importRule('../../../presets/go/rules/go-sql-injection.ts', 'goSqlInjectionRule'),
  'fastapi-missing-auth': () => importRule('../../../presets/python-fastapi/rules/fastapi-missing-auth.ts', 'fastapiMissingAuthRule'),
  't3-server-only':       () => importRule('../../../presets/t3/rules/t3-server-only.ts', 't3ServerOnlyRule'),
  'rails-sql-injection':  () => importRule('../../../presets/rails-postgres/rules/rails-sql-injection.ts', 'railsSqlInjectionRule'),
};

const ALL = { ...BUILTIN, ...PRESET };

export async function loadRulesFromConfig(refs: StaticRuleReference[]): Promise<StaticRule[]> {
  const rules: StaticRule[] = [];
  for (const ref of refs) {
    const name = typeof ref === 'string' ? ref : ref.adapter;
    const loader = ALL[name];
    if (loader) {
      rules.push(await loader());
    } else {
      process.stderr.write(`[guardrail] Unknown static rule: "${name}" — skipping\n`);
    }
  }
  return rules;
}

export function listAvailableRules(): string[] {
  return Object.keys(ALL);
}
