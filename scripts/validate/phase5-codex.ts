import * as fs from 'fs';
import * as path from 'path';
import { Finding, PhaseResult } from './types';
import { isProtectedPath } from './protected-paths';
import { runSafe } from './exec-utils';
import { stageFiles, commitChanges, storeFileBackup, restoreFileBackup } from './git-utils';
import { loadEnv } from '../load-env';

loadEnv();

interface CodexFinding {
  severity: 'critical' | 'warning' | 'note';
  title: string;
  message: string;
  suggestion: string;
}

function parseCodexOutput(output: string): CodexFinding[] {
  const findings: CodexFinding[] = [];
  // Match ### [CRITICAL] Title\nbody\n**Suggestion:** text
  const regex = /### \[(CRITICAL|WARNING|NOTE)\]\s*(.+?)(?=\n### \[|## Review Summary|$)/gs;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const severity = match[1].toLowerCase() as CodexFinding['severity'];
    const body = match[2].trim();
    const titleEnd = body.indexOf('\n');
    const title = titleEnd > 0 ? body.slice(0, titleEnd).trim() : body;
    const suggestion = body.match(/\*\*Suggestion:\*\*\s*(.+)/s)?.[1]?.trim() || '';
    findings.push({ severity, title, message: body, suggestion });
  }
  return findings;
}

function batchByModule(files: string[]): Map<string, string[]> {
  const batches = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split('/');
    const moduleDir = parts.slice(0, Math.min(4, parts.length - 1)).join('/');
    const existing = batches.get(moduleDir) || [];
    existing.push(file);
    batches.set(moduleDir, existing);
  }
  return batches;
}

function findMostRecent(dir: string, ext: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(dir, files[0].f) : null;
  } catch { return null; }
}

function buildSpecContext(): string {
  const spec = findMostRecent('docs/superpowers/specs', '.md');
  const plan = findMostRecent('docs/superpowers/plans', '.md');
  const parts: string[] = [];
  if (spec) {
    try {
      parts.push(`# Spec: ${path.basename(spec)}\n${fs.readFileSync(spec, 'utf-8')}`);
    } catch { /* ignore */ }
  }
  if (plan) {
    try {
      parts.push(`# Plan: ${path.basename(plan)}\n${fs.readFileSync(plan, 'utf-8')}`);
    } catch { /* ignore */ }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') + '\n\n---\n\n' : '';
}

export async function runPhase5(
  touchedFiles: string[],
  options: { commitAutofix: boolean; verbose: boolean }
): Promise<PhaseResult> {
  const start = Date.now();
  const findings: Finding[] = [];
  const MAX_ITERATIONS = 3;

  const reviewableFiles = touchedFiles.filter(
    f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.') && !f.includes('__tests__')
  );

  if (reviewableFiles.length === 0) {
    return { phase: 'codex', status: 'pass', findings: [], durationMs: Date.now() - start };
  }

  const specContext = buildSpecContext();
  const batches = batchByModule(reviewableFiles);

  for (const [module, files] of batches) {
    // Build batch content for Codex review
    const batchContent = files.map(f => {
      try {
        const content = fs.readFileSync(f, 'utf-8').slice(0, 3000);
        return `## ${f}\n\`\`\`typescript\n${content}\n\`\`\`\n`;
      } catch { return ''; }
    }).filter(Boolean).join('\n');

    const tmpFile = `/tmp/codex-validate-${module.replace(/\//g, '-')}.md`;
    fs.writeFileSync(tmpFile, `# Code Review: ${module}\n\n${specContext}${batchContent}`);

    // Run Codex review
    let output: string | null = null;
    try {
      output = runSafe('npx', ['tsx', 'scripts/codex-review.ts', tmpFile], { timeout: 120000 });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    if (!output) {
      if (options.verbose) console.warn(`[validate] Codex review failed for ${module}`);
      continue;
    }

    const codexFindings = parseCodexOutput(output);

    for (const cf of codexFindings) {
      const matchedFile = files.find(f => output.includes(f) || output.includes(path.basename(f))) || files[0];
      findings.push({
        id: `codex-${module.replace(/\//g, '-')}-${findings.length}`,
        phase: 'codex',
        severity: cf.severity,
        category: 'codex-review',
        file: matchedFile,
        message: cf.title,
        suggestion: cf.suggestion,
        status: 'open',
        fixAttempted: false,
        protectedPath: isProtectedPath(matchedFile),
      });
    }
  }

  // Auto-fix loop for CRITICAL/WARNING on non-protected paths
  let iteration = 0;
  const fixable = findings.filter(
    f => (f.severity === 'critical' || f.severity === 'warning') && !f.protectedPath && f.status === 'open'
  );

  for (const finding of fixable) {
    if (iteration >= MAX_ITERATIONS) break;

    // Snapshot all currently modified files before the fix attempt so we can
    // restore exactly those files (and only those files) on failure, without
    // disturbing any previously staged or unrelated working-tree changes.
    const modifiedBefore = runSafe('git', ['diff', '--name-only']) || '';
    const modifiedFiles = modifiedBefore.trim().split('\n').filter(Boolean);
    const backups = new Map<string, string>();
    for (const f of modifiedFiles) {
      const content = storeFileBackup(f);
      if (content !== null) backups.set(f, content);
    }

    // Attempt fix via claude -p
    const fixPrompt = [
      `Fix this issue in ${finding.file}:`,
      finding.message,
      `Suggestion: ${finding.suggestion}`,
      'Apply the minimal fix. Only modify the specific issue. Do not change anything else.',
    ].join('\n\n');

    const fixResult = runSafe('claude', ['-p', '--allowedTools', 'Edit,Read', '--max-turns', '3'], {
      input: fixPrompt,
      timeout: 60000,
    });

    finding.fixAttempted = true;

    if (fixResult) {
      // Verify: run tests for this file's directory
      const testDir = `${path.dirname(finding.file)  }/__tests__/`;
      const testResult = runSafe('npx', ['jest', testDir, '--silent'], { timeout: 60000 });

      if (testResult !== null) {
        // Fix verified — keep working tree as-is
        finding.status = 'fixed';
      } else {
        // Tests failed — restore all files that existed before the fix attempt
        for (const [f, content] of backups) {
          restoreFileBackup(f, content);
        }
        finding.status = 'reverted';
      }
    } else {
      // Fix attempt failed — restore all files that existed before the fix attempt
      for (const [f, content] of backups) {
        restoreFileBackup(f, content);
      }
      finding.status = 'human_required';
    }

    iteration++;
  }

  // Commit auto-fixes if requested
  const fixedFiles = findings.filter(f => f.status === 'fixed').map(f => f.file);
  if (options.commitAutofix && fixedFiles.length > 0) {
    stageFiles(fixedFiles);
    commitChanges('fix(validate): address Codex review findings');
  }

  // Mark remaining unfixed criticals
  for (const f of findings) {
    if (f.status === 'open' && f.severity === 'critical') {
      f.status = 'human_required';
    }
  }

  const blocking = findings.filter(f => f.severity === 'critical' && f.status !== 'fixed').length;
  return {
    phase: 'codex',
    status: blocking > 0 ? 'fail' : 'pass',
    findings,
    durationMs: Date.now() - start,
  };
}
