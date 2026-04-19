import * as path from 'path';
import { run, runSafe } from './exec-utils';
import { Finding, PhaseResult } from './types';
import { checkEmailSenderDomains } from './check-email-sender-domains';
import { checkUncheckedEmailSends } from './check-unchecked-email-sends';

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, 'severity' | 'category' | 'file' | 'message'>
): Finding {
  return {
    id: `phase1-${crypto.randomUUID()}`,
    phase: 'static',
    line: undefined,
    suggestion: undefined,
    status: 'open',
    fixAttempted: false,
    fixCommitSha: undefined,
    protectedPath: false,
    ...overrides,
  };
}

async function checkMigrationIntegrity(touchedFiles: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fs = require('fs');

  // Skip entirely if the project hasn't provided a migrate script.
  // Implement scripts/supabase/migrate.ts (or your equivalent) and this
  // check will automatically activate.
  if (!fs.existsSync('scripts/supabase/migrate.ts')) return findings;

  const sqlFiles = touchedFiles.filter(
    f => f.startsWith('data/deltas/') && f.endsWith('.sql')
  );

  for (const file of sqlFiles) {
    const result = runSafe('npx', [
      'tsx',
      'scripts/supabase/migrate.ts',
      file,
      '--env',
      'dev',
      '--dry-run',
    ]);

    // runSafe returns null on non-zero exit; capture stderr via spawnSync-like approach
    // by checking null return as a signal of error output
    if (result === null) {
      findings.push(
        makeFinding({
          severity: 'critical',
          category: 'migration-integrity',
          file,
          message: `Migration dry-run failed for ${path.basename(file)} — check SQL syntax or schema conflicts`,
          suggestion: `Run: npx tsx scripts/supabase/migrate.ts ${file} --env dev --dry-run`,
        })
      );
    } else {
      // Check stdout/combined output for ERROR lines
      const errorLines = result
        .split('\n')
        .filter(line => /\bERROR\b/i.test(line));
      for (const errorLine of errorLines) {
        findings.push(
          makeFinding({
            severity: 'critical',
            category: 'migration-integrity',
            file,
            message: `Migration dry-run ERROR: ${errorLine.trim()}`,
            suggestion: `Review SQL in ${file}`,
          })
        );
      }
    }
  }

  return findings;
}

async function checkMigrationLedger(touchedFiles: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fs = require('fs');
  if (!fs.existsSync('scripts/supabase/migrate.ts')) return findings;

  const sqlFiles = touchedFiles.filter(
    f => f.startsWith('data/deltas/') && f.endsWith('.sql')
  );

  for (const file of sqlFiles) {
    const name = path.basename(file, '.sql');
    const result = runSafe('npx', [
      'tsx',
      'scripts/supabase/migrate.ts',
      '--inspect',
      name,
      '--env',
      'dev',
    ]);

    if (result !== null && /not found|not applied/i.test(result)) {
      findings.push(
        makeFinding({
          severity: 'warning',
          category: 'migration-ledger',
          file,
          message: `Migration "${name}" not found or not applied in dev ledger`,
          suggestion: `Run migration against dev: npx tsx scripts/supabase/migrate.ts ${file} --env dev`,
        })
      );
    }
  }

  return findings;
}

async function checkPackageLockSync(touchedFiles: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fs = require('fs');

  if (!fs.existsSync('package.json')) return findings;

  // Trigger if package.json changed on branch (committed) or in working tree (staged/unstaged)
  const pkgInTouched = touchedFiles.some(f => f === 'package.json');
  const pkgStagedDirty = (runSafe('git', ['diff', '--name-only', '--cached', 'package.json']) || '').trim();
  const pkgUnstagedDirty = (runSafe('git', ['diff', '--name-only', 'package.json']) || '').trim();

  if (!pkgInTouched && !pkgStagedDirty && !pkgUnstagedDirty) return findings;

  if (!fs.existsSync('package-lock.json')) {
    findings.push(makeFinding({
      severity: 'critical',
      category: 'package-lock-sync',
      file: 'package.json',
      message: 'package.json was modified but package-lock.json does not exist',
      suggestion: 'Run: npm install',
    }));
    return findings;
  }

  // Regenerate the lockfile from package.json and check for drift.
  // --prefer-offline avoids network if packages are cached; falls back to registry if not.
  // --ignore-scripts skips lifecycle hooks so this is safe to run anywhere.
  const regenResult = runSafe('npm', [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--prefer-offline',
  ]);

  if (regenResult === null) {
    // npm failed (network unavailable, bad package name, etc.) — report but don't block
    findings.push(makeFinding({
      severity: 'warning',
      category: 'package-lock-sync',
      file: 'package-lock.json',
      message: 'Could not verify package-lock.json sync — npm install --package-lock-only failed',
      suggestion: 'Run manually: npm install --package-lock-only && git add package-lock.json',
    }));
    return findings;
  }

  const lockDiff = (runSafe('git', ['diff', '--stat', 'package-lock.json']) || '').trim();

  if (lockDiff) {
    // Lockfile was stale — stage the regenerated version so it gets picked up
    runSafe('git', ['add', 'package-lock.json']);
    findings.push(makeFinding({
      severity: 'warning',
      category: 'package-lock-sync',
      file: 'package-lock.json',
      message: 'package-lock.json was out of sync with package.json — regenerated and staged',
      suggestion: 'Include package-lock.json in your commit',
      status: 'fixed',
      fixAttempted: true,
    }));
  }

  return findings;
}

async function checkNpmAudit(): Promise<Finding[]> {
  const findings: Finding[] = [];

  // npm audit exits non-zero when vulnerabilities are found, so we must
  // capture stdout from the error rather than treating a non-zero exit as
  // "no output". Use execFileSync directly and catch the error's stdout.
  let auditOutput: string | null = null;
  try {
    auditOutput = run('npm', ['audit', '--json']);
  } catch (err: unknown) {
    const spawnErr = err as { stdout?: string };
    auditOutput = spawnErr.stdout ?? null;
  }

  if (!auditOutput) return findings;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(auditOutput);
  } catch {
    return findings;
  }

  const vulns = parsed.vulnerabilities as Record<
    string,
    { severity: string; name?: string }
  > | undefined;
  if (!vulns) return findings;

  for (const [pkgName, vuln] of Object.entries(vulns)) {
    const sev = (vuln.severity ?? '').toLowerCase();
    if (sev === 'critical') {
      findings.push(
        makeFinding({
          severity: 'critical',
          category: 'npm-audit',
          file: 'package.json',
          message: `Critical vulnerability in ${pkgName}: ${sev}`,
          suggestion: 'Run: npm audit fix',
        })
      );
    } else if (sev === 'high') {
      findings.push(
        makeFinding({
          severity: 'warning',
          category: 'npm-audit',
          file: 'package.json',
          message: `High severity vulnerability in ${pkgName}`,
          suggestion: 'Run: npm audit fix',
        })
      );
    }
  }

  return findings;
}

/**
 * Security scanning: check touched files for dangerous patterns.
 *
 * GENERIC checks (keep as-is):
 * - Hardcoded secrets/API keys in source code
 *
 * STACK-SPECIFIC checks (customize or remove for your stack):
 * - `createServiceRoleClient` in client-side code (Supabase RLS bypass)
 * - Stack-specific tenant isolation (e.g., Weaviate `.withTenant()`)
 * Add your own checks following the same pattern.
 */
async function checkSecurityPatterns(touchedFiles: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fs = require('fs');

  const tsFiles = touchedFiles.filter(f =>
    (f.endsWith('.ts') || f.endsWith('.tsx')) && fs.existsSync(f)
  );

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    // GENERIC: hardcoded secrets (API keys, tokens)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;

      // Match patterns like: key = "sk-..." or token: "eyJ..."
      if (/(?:key|token|secret|password|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i.test(line)) {
        if (!file.includes('.test.') && !file.includes('__tests__') && !line.includes('process.env')) {
          findings.push(makeFinding({
            severity: 'critical',
            category: 'security-hardcoded-secret',
            file,
            line: i + 1,
            message: 'Possible hardcoded secret/API key detected',
            suggestion: 'Move to an environment variable',
          }));
        }
      }
    }

    // --- STACK-SPECIFIC CHECKS ---
    // These are disabled by default. Uncomment and adapt for your stack.
    // For LLM-reviewed security rules, use .autopilot/stack.md instead —
    // add them under "Things that should flag CRITICAL" and the Codex review
    // (phase 5) will catch them on every PR without any code changes here.
    //
    // Example — Supabase: service role client in client-side code
    // const isClientSide = file.includes('app/components/') || file.endsWith('.tsx') && !file.includes('api/');
    // if (isClientSide && content.includes('createServiceRoleClient')) {
    //   findings.push(makeFinding({ severity: 'critical', category: 'security-service-role', file,
    //     message: 'createServiceRoleClient() in client-side code exposes service key',
    //     suggestion: 'Use a server-only DB client instead' }));
    // }
    //
    // Example — Weaviate: multi-tenant queries must include .withTenant()
    // if ((content.includes('weaviate') || content.includes('Weaviate')) &&
    //     (content.includes('.query(') || content.includes('.get(')) && !content.includes('.withTenant(')) {
    //   findings.push(makeFinding({ severity: 'critical', category: 'security-tenant', file,
    //     message: 'Weaviate query without .withTenant() — cross-tenant data leak',
    //     suggestion: 'Add .withTenant(tenantId) to every Weaviate query' }));
    // }
  }

  return findings;
}

export async function runPhase1(touchedFiles: string[]): Promise<PhaseResult> {
  const start = Date.now();

  const [
    migrationFindings,
    ledgerFindings,
    packageLockFindings,
    auditFindings,
    securityFindings,
    emailSenderFindings,
    uncheckedEmailSendFindings,
  ] = await Promise.all([
    checkMigrationIntegrity(touchedFiles),
    checkMigrationLedger(touchedFiles),
    checkPackageLockSync(touchedFiles),
    checkNpmAudit(),
    checkSecurityPatterns(touchedFiles),
    // Wrap in its own try so a stray AWS SDK issue can't take down phase 1.
    // The check itself handles missing AWS creds gracefully (returns a NOTE),
    // but e.g. a broken import would still surface here.
    checkEmailSenderDomains().then((partials) =>
      partials.map((p) => makeFinding(p)),
    ).catch((err) => [
      makeFinding({
        severity: 'note',
        category: 'email-sender-drift',
        file: 'app/services/email/email.types.ts',
        message: `Email sender domain check threw: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: 'Investigate; the check should never throw (returns a NOTE when AWS creds are missing).',
      }),
    ]),
    // AST-based silent-failure trap for `emailService.send()` result
    // handling. Returns warnings only — the check is advisory because some
    // fire-and-forget patterns are legitimately acceptable.
    checkUncheckedEmailSends().then((partials) =>
      partials.map((p) => makeFinding(p)),
    ).catch((err) => [
      makeFinding({
        severity: 'note',
        category: 'email-send-unchecked',
        file: 'scripts/validate/check-unchecked-email-sends.ts',
        message: `Unchecked email send check threw: ${err instanceof Error ? err.message : String(err)}`,
      }),
    ]),
  ]);

  const findings: Finding[] = [
    ...migrationFindings,
    ...ledgerFindings,
    ...packageLockFindings,
    ...auditFindings,
    ...securityFindings,
    ...emailSenderFindings,
    ...uncheckedEmailSendFindings,
  ];

  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasWarning = findings.some(f => f.severity === 'warning');

  let status: PhaseResult['status'] = 'pass';
  if (hasCritical) status = 'fail';
  else if (hasWarning) status = 'warn';

  return {
    phase: 'static',
    status,
    findings,
    durationMs: Date.now() - start,
  };
}
