import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../core/config/loader.ts';
import { loadAdapter } from '../adapters/loader.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import { findCoverageGaps } from '../core/test-gen/coverage-analyzer.ts';
import { detectTestFramework } from '../core/test-gen/framework-detector.ts';
import { writeGeneratedTest, buildGenerationPrompt } from '../core/test-gen/test-writer.ts';

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m' };

export interface TestGenOptions {
  cwd?: string;
  configPath?: string;
  targets?: string[];
  base?: string;
  dryRun?: boolean;
  verify?: boolean;
}

export async function runTestGen(options: TestGenOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');

  let config = { configVersion: 1 as const, testCommand: null as string | null };
  if (fs.existsSync(configPath)) {
    try {
      const loaded = await loadConfig(configPath);
      if (loaded) config = loaded as typeof config;
    } catch {
      // proceed with defaults if config fails to load
    }
  }

  // Collect files to analyze
  let files: string[];
  if (options.targets && options.targets.length > 0) {
    files = options.targets.map(t => path.isAbsolute(t) ? t : path.resolve(cwd, t));
  } else {
    // Fall back to git-changed files
    try {
      const base = options.base ?? 'HEAD~1';
      const out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd, encoding: 'utf8' });
      files = out.trim().split('\n').filter(Boolean).map(f => path.resolve(cwd, f));
    } catch {
      console.error(`${C.red}[test-gen] No targets specified and git diff failed. Pass a path: guardrail test-gen src/${C.reset}`);
      return 1;
    }
  }

  console.log(`${C.bold}[test-gen]${C.reset} Analyzing ${files.length} file(s)...`);
  const gaps = findCoverageGaps(files);

  if (gaps.length === 0) {
    console.log(`${C.green}[test-gen] No coverage gaps found${C.reset}`);
    return 0;
  }

  for (const gap of gaps) {
    const rel = path.relative(cwd, gap.file);
    const covered = gap.exports.length;
    console.log(`  ${C.cyan}${rel}${C.reset}  ${covered} uncovered export(s): ${gap.exports.join(', ')}`);
  }

  if (options.dryRun) {
    console.log(`\n${C.yellow}[test-gen] Dry run — not generating tests${C.reset}`);
    return 0;
  }

  // Load review engine for generation
  const engineRef = (config as { reviewEngine?: unknown }).reviewEngine ?? 'auto';
  let engine: Awaited<ReturnType<typeof loadAdapter>>;
  try {
    engine = await loadAdapter({ point: 'review-engine', ref: engineRef as string });
  } catch (err) {
    console.error(`${C.red}[test-gen] Could not load review engine: ${err}${C.reset}`);
    return 1;
  }

  const framework = detectTestFramework(cwd);
  const written: string[] = [];

  for (const gap of gaps) {
    let sourceContent: string;
    try { sourceContent = fs.readFileSync(gap.file, 'utf8'); } catch { continue; }

    const prompt = buildGenerationPrompt(gap, sourceContent, framework);

    process.stdout.write(`  Generating ${path.relative(cwd, gap.testFile)}... `);
    try {
      const result = await (engine as unknown as ReviewEngine).review({ content: prompt, kind: 'spec', context: { cwd } });

      // Extract code block if wrapped in markdown
      let code = result.rawOutput.trim();
      const fenceMatch = code.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
      if (fenceMatch) code = fenceMatch[1]!.trim();

      const testPath = writeGeneratedTest(gap, code);
      written.push(testPath);
      console.log(`${C.green}done${C.reset}`);

      // Verify mode
      if (options.verify && config.testCommand) {
        try {
          const [cmd, ...cmdArgs] = config.testCommand.split(/\s+/);
          execFileSync(cmd!, cmdArgs, { cwd, stdio: 'ignore', timeout: 60_000 });
        } catch {
          fs.unlinkSync(testPath);
          written.pop();
          console.log(`  ${C.yellow}  ↳ tests failed — reverted${C.reset}`);
        }
      }
    } catch (err) {
      console.log(`${C.red}failed: ${err}${C.reset}`);
    }
  }

  if (written.length > 0) {
    console.log(`\n${C.green}[test-gen] Generated ${written.length} test file(s):${C.reset}`);
    for (const f of written) console.log(`  ${path.relative(cwd, f)}`);
  }

  return 0;
}
