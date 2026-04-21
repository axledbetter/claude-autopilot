#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from '../core/config/loader.ts';
import { resolvePreset } from '../core/config/preset-resolver.ts';
import { mergeConfigs } from '../core/config/preset-resolver.ts';
import { loadAdapter } from '../adapters/loader.ts';
import { runAutopilot } from '../core/pipeline/run.ts';
import { resolveGitTouchedFiles } from '../core/git/touched-files.ts';
import type { RunInput } from '../core/pipeline/run.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { AutopilotConfig } from '../core/config/types.ts';
import { fileURLToPath } from 'node:url';
import { toSarif } from '../formatters/sarif.ts';
import { emitAnnotations } from '../formatters/github-annotations.ts';

function readToolVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function fmt(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

export interface RunCommandOptions {
  cwd?: string;
  configPath?: string;
  base?: string;       // git base ref (default HEAD~1)
  files?: string[];    // explicit file list (skips git detection)
  dryRun?: boolean;    // skip review, print what would run
  format?: 'text' | 'sarif';
  outputPath?: string;
}

/**
 * Returns an exit code (0 = pass/warn, 1 = fail/error).
 * Never calls process.exit directly — caller decides when to exit.
 */
export async function runCommand(options: RunCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'autopilot.config.yaml');

  if (!fs.existsSync(configPath)) {
    console.error(fmt('red', `[run] autopilot.config.yaml not found at ${configPath}`));
    console.error(fmt('dim', '      Run: npx autopilot init'));
    return 1;
  }

  // Load + merge config
  let config: AutopilotConfig;
  try {
    const userConfig = await loadConfig(configPath);
    if (userConfig.preset) {
      const preset = await resolvePreset(userConfig.preset);
      config = mergeConfigs(preset.config, userConfig);
    } else {
      config = userConfig;
    }
  } catch (err) {
    console.error(fmt('red', `[run] Config error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // Resolve touched files
  const touchedFiles = options.files ?? resolveGitTouchedFiles({ cwd, base: options.base });
  if (touchedFiles.length === 0) {
    console.log(fmt('yellow', '[run] No changed files detected — nothing to review.'));
    console.log(fmt('dim', '      Pass --base <ref> to compare against a different branch/commit.'));
    return 0;
  }

  console.log(`\n${fmt('bold', '[autopilot run]')} ${fmt('dim', configPath)}`);
  console.log(`${fmt('dim', `  ${touchedFiles.length} changed file(s):`)} ${touchedFiles.slice(0, 5).join(', ')}${touchedFiles.length > 5 ? ` … +${touchedFiles.length - 5} more` : ''}`);

  if (options.dryRun) {
    console.log(fmt('yellow', '\n[run] Dry run — skipping pipeline execution.\n'));
    return 0;
  }

  // Load review engine (optional — skip if no OPENAI_API_KEY or not configured)
  let reviewEngine: ReviewEngine | undefined;
  if (config.reviewEngine) {
    const ref = typeof config.reviewEngine === 'string' ? config.reviewEngine : config.reviewEngine.adapter;
    const hasKey = !!(process.env.OPENAI_API_KEY);
    if (!hasKey && ref === 'codex') {
      console.log(fmt('yellow', '\n  [run] OPENAI_API_KEY not set — Codex review step will be skipped'));
    } else {
      try {
        reviewEngine = await loadAdapter<ReviewEngine>({
          point: 'review-engine',
          ref,
          options: typeof config.reviewEngine === 'string' ? undefined : config.reviewEngine.options,
        });
      } catch (err) {
        console.error(fmt('yellow', `  [run] Could not load review engine (${ref}): ${err instanceof Error ? err.message : String(err)} — skipping`));
      }
    }
  }

  // Execute pipeline
  const input: RunInput = {
    touchedFiles,
    config,
    reviewEngine,
    cwd,
  };

  console.log('');
  const result = await runAutopilot(input);

  // Emit GitHub Actions annotations when running in CI
  if (process.env.GITHUB_ACTIONS === 'true') {
    emitAnnotations(result.allFindings);
  }

  // Write SARIF output if requested
  if (options.format === 'sarif' && options.outputPath) {
    const sarif = toSarif(result, { toolVersion: readToolVersion(), cwd });
    fs.writeFileSync(options.outputPath, JSON.stringify(sarif, null, 2), 'utf8');
    console.log(fmt('dim', `[run] SARIF written to ${options.outputPath}`));
  }

  // Print phase summaries
  for (const phase of result.phases) {
    const icon = phase.status === 'pass' ? fmt('green', '✓') :
                 phase.status === 'skip' ? fmt('dim', '–') :
                 phase.status === 'warn' ? fmt('yellow', '!') : fmt('red', '✗');
    const phaseLabel = phase.phase.padEnd(14);
    const findingCount = phase.findings.length;
    const extra = findingCount > 0 ? fmt('dim', ` (${findingCount} finding${findingCount !== 1 ? 's' : ''})`) : '';
    const dur = 'durationMs' in phase ? fmt('dim', ` ${phase.durationMs}ms`) : '';
    console.log(`  ${icon}  ${phaseLabel}${extra}${dur}`);

    // Print critical/warning findings inline
    for (const f of phase.findings) {
      if (f.severity === 'critical' || f.severity === 'warning') {
        const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING ');
        console.log(`       ${sev}  ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
        if (f.suggestion) console.log(fmt('dim', `                ${f.suggestion}`));
      }
    }
  }

  // Cost summary
  if (result.totalCostUSD !== undefined) {
    console.log(`\n  ${fmt('dim', `cost: $${result.totalCostUSD.toFixed(4)}`)}  ${fmt('dim', `${result.durationMs}ms total`)}`);
  } else {
    console.log(`\n  ${fmt('dim', `${result.durationMs}ms total`)}`);
  }

  // Final verdict
  console.log('');
  if (result.status === 'pass') {
    console.log(fmt('green', '[run] ✓ All phases passed\n'));
    return 0;
  } else if (result.status === 'warn') {
    console.log(fmt('yellow', '[run] ! Passed with warnings\n'));
    return 0;
  } else {
    console.log(fmt('red', '[run] ✗ Pipeline failed — see findings above\n'));
    return 1;
  }
}
