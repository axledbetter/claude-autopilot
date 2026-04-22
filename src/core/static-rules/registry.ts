import type { StaticRule } from '../phases/static-rules.ts';
import type { StaticRuleReference } from '../config/types.ts';

// Built-in cross-stack rules
const BUILTIN: Record<string, () => Promise<StaticRule>> = {
  'hardcoded-secrets': () => import('./rules/hardcoded-secrets.ts').then(m => m.hardcodedSecretsRule),
  'npm-audit':         () => import('./rules/npm-audit.ts').then(m => m.npmAuditRule),
  'package-lock-sync': () => import('./rules/package-lock-sync.ts').then(m => m.packageLockSyncRule),
  'console-log':       () => import('./rules/console-log.ts').then(m => m.consoleLogRule),
  'todo-fixme':        () => import('./rules/todo-fixme.ts').then(m => m.todoFixmeRule),
  'large-file':        () => import('./rules/large-file.ts').then(m => m.largeFileRule),
  'missing-tests':     () => import('./rules/missing-tests.ts').then(m => m.missingTestsRule),
};

// Preset-specific rules registered by name
const PRESET: Record<string, () => Promise<StaticRule>> = {
  'supabase-rls-bypass': () => import('../../../presets/nextjs-supabase/rules/supabase-rls-bypass.ts').then(m => m.supabaseRlsBypassRule),
  'go-sql-injection':    () => import('../../../presets/go/rules/go-sql-injection.ts').then(m => m.goSqlInjectionRule),
  'fastapi-missing-auth': () => import('../../../presets/python-fastapi/rules/fastapi-missing-auth.ts').then(m => m.fastapiMissingAuthRule),
  't3-server-only':      () => import('../../../presets/t3/rules/t3-server-only.ts').then(m => m.t3ServerOnlyRule),
  'rails-sql-injection': () => import('../../../presets/rails-postgres/rules/rails-sql-injection.ts').then(m => m.railsSqlInjectionRule),
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
      process.stderr.write(`[autopilot] Unknown static rule: "${name}" — skipping\n`);
    }
  }
  return rules;
}

export function listAvailableRules(): string[] {
  return Object.keys(ALL);
}
