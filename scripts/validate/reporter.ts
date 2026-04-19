import * as fs from 'fs';
import * as path from 'path';
import { ValidationReport, PhaseResult, Finding } from './types';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

function colorSeverity(severity: Finding['severity']): string {
  switch (severity) {
    case 'critical': return `${c.red}${c.bold}CRITICAL${c.reset}`;
    case 'warning':  return `${c.yellow}WARNING${c.reset}`;
    case 'note':     return `${c.dim}NOTE${c.reset}`;
  }
}

function colorStatus(status: Finding['status']): string {
  switch (status) {
    case 'fixed':          return `${c.green}FIXED${c.reset}`;
    case 'reverted':       return `${c.yellow}REVERTED${c.reset}`;
    case 'human_required': return `${c.red}HUMAN_REQUIRED${c.reset}`;
    case 'skipped':        return `${c.dim}SKIPPED${c.reset}`;
    case 'open':           return `${c.white}OPEN${c.reset}`;
  }
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    static:             'Static',
    'static-recheck':   'Static (re-check)',
    autofix:            'Auto-Fix',
    tests:              'Tests',
    'tests-post-codex': 'Tests (post-Codex)',
    codex:              'Codex Review',
    gate:               'Final Gate',
    bugbot:             'Bugbot',
  };
  return labels[phase] ?? phase;
}

function phaseStatusIcon(status: PhaseResult['status']): string {
  switch (status) {
    case 'pass':    return `${c.green}✓${c.reset}`;
    case 'fail':    return `${c.red}✗${c.reset}`;
    case 'warn':    return `${c.yellow}!${c.reset}`;
    case 'skipped': return `${c.dim}-${c.reset}`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function divider(char = '═', width = 55): string {
  return char.repeat(width);
}

export function printReport(report: ValidationReport): void {
  const border = divider();

  console.log(`\n${c.bold}${border}${c.reset}`);
  console.log(`${c.bold}  /validate — Pre-PR Validation Report${c.reset}`);
  console.log(`${c.bold}${border}${c.reset}`);
  console.log(`  Branch:  ${c.cyan}${report.branch}${c.reset}`);
  console.log(`  Base:    ${c.dim}${report.mergeBase.slice(0, 8)}${c.reset}`);
  console.log(`  Mode:    ${report.mode}`);
  console.log(`  Files:   ${report.touchedFiles.length} touched`);
  console.log('');

  for (const phase of report.phases) {
    const icon = phaseStatusIcon(phase.status);
    const label = phaseLabel(phase.phase);
    const dur = formatDuration(phase.durationMs);

    console.log(`${c.bold}Phase: ${label}${c.reset} ${icon} ${c.dim}(${dur})${c.reset}`);

    const visible = phase.findings.filter(f => f.status !== 'skipped');
    if (visible.length === 0) {
      console.log(`  ${c.dim}No findings${c.reset}`);
    } else {
      for (const f of visible) {
        const sevLabel = colorSeverity(f.severity);
        const statusLabel = f.status !== 'open' ? ` [${colorStatus(f.status)}]` : '';
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        console.log(`  ${sevLabel}${statusLabel} ${c.dim}${loc}${c.reset} — ${f.message}`);
        if (f.suggestion && f.status === 'open') {
          console.log(`    ${c.dim}Suggestion: ${f.suggestion}${c.reset}`);
        }
      }
    }
    console.log('');
  }

  console.log(`${c.bold}${border}${c.reset}`);

  const { verdict, summary } = report;
  const verdictDisplay = verdict === 'PASS'
    ? `${c.bgGreen}${c.bold}  VERDICT: PASS ✓  ${c.reset}`
    : `${c.bgRed}${c.bold}  VERDICT: FAIL ✗  ${c.reset}`;

  console.log(`  ${verdictDisplay}`);
  console.log(
    `  Auto-fixed: ${c.green}${summary.autoFixed}${c.reset}` +
    ` | Human-required: ${summary.humanRequired > 0 ? c.red : c.dim}${summary.humanRequired}${c.reset}` +
    ` | Warnings: ${summary.warnings > 0 ? c.yellow : c.dim}${summary.warnings}${c.reset}` +
    ` | Blocking: ${summary.blocking > 0 ? c.red + c.bold : c.dim}${summary.blocking}${c.reset}`
  );
  console.log(`${c.bold}${border}${c.reset}\n`);
}

export function saveReport(report: ValidationReport, outputPath?: string): void {
  const reportPath = outputPath ?? path.join(process.cwd(), '.claude', 'validation-report.json');
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[validate] Report saved to ${reportPath}`);
}
