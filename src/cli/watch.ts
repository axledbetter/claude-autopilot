import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../core/config/loader.ts';
import { resolvePreset, mergeConfigs } from '../core/config/preset-resolver.ts';
import { loadAdapter } from '../adapters/loader.ts';
import { runGuardrail } from '../core/pipeline/run.ts';
import type { ReviewEngine } from '../adapters/review-engine/types.ts';
import type { GuardrailConfig } from '../core/config/types.ts';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const fmt = (c: keyof typeof C, t: string) => `${C[c]}${t}${C.reset}`;

// Anchored to path segment boundaries — avoids matching "mynode_modules" or similar
export const IGNORED_PATTERNS: readonly RegExp[] = [
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])\.guardrail-cache([/\\]|$)/,
  /\.(log|tmp|swp|swo|DS_Store)$/,
  /~$/,
];

export function isIgnored(p: string): boolean {
  return IGNORED_PATTERNS.some(r => r.test(p));
}

/**
 * Pure debounce accumulator — returned functions are the testable core of watch logic.
 * schedule(file) → adds file, starts/resets timer; when debounce fires, calls flush(batch).
 * onSchedule (optional) is called on every schedule() with the file and current queue size.
 */
export function makeDebouncer(
  flushFn: (batch: string[]) => void,
  debounceMs: number,
  onSchedule?: (file: string, queueSize: number) => void,
): { schedule: (file: string) => void; pending: () => string[] } {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(file: string) {
      pending.add(file);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const batch = [...pending];
        pending.clear();
        timer = null;
        flushFn(batch);
      }, debounceMs);
      onSchedule?.(file, pending.size);
    },
    pending() { return [...pending]; },
  };
}

export interface WatchOptions {
  cwd?: string;
  configPath?: string;
  debounceMs?: number;
}

export async function runWatch(options: WatchOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.join(cwd, 'guardrail.config.yaml');
  const debounceMs = options.debounceMs ?? 300;

  // Zero-config fallback — same as `run`
  let config: GuardrailConfig;
  if (!fs.existsSync(configPath)) {
    config = { configVersion: 1, reviewEngine: { adapter: 'auto' }, testCommand: null };
  } else {
    try {
      const userConfig = await loadConfig(configPath);
      config = userConfig.preset
        ? mergeConfigs((await resolvePreset(userConfig.preset)).config, userConfig)
        : userConfig;
    } catch (err) {
      console.error(fmt('red', `[watch] Config error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  }

  const hasAnyKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);

  let reviewEngine: ReviewEngine | undefined;
  if (config.reviewEngine && hasAnyKey) {
    const ref = typeof config.reviewEngine === 'string' ? config.reviewEngine : config.reviewEngine.adapter;
    try {
      reviewEngine = await loadAdapter<ReviewEngine>({
        point: 'review-engine', ref,
        options: typeof config.reviewEngine === 'string' ? undefined : config.reviewEngine.options,
      });
    } catch { /* skip — static rules still run */ }
  }

  const keyStatus = hasAnyKey
    ? fmt('green', '✓ LLM review enabled')
    : fmt('yellow', '! No API key — static rules only  (set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY)');

  console.log(`\n${fmt('bold', '[guardrail watch]')} ${fmt('dim', cwd)}`);
  console.log(fmt('dim', `  debounce: ${debounceMs}ms  |  Ctrl+C to exit`));
  console.log(`  ${keyStatus}\n`);
  console.log(fmt('dim', '  Watching for changes…\n'));

  let running = false;
  const nextPending = new Set<string>();
  let debounceLineShown = false;

  const runBatch = async (batch: string[]) => {
    debounceLineShown = false;
    if (running) {
      for (const f of batch) nextPending.add(f);
      return;
    }
    running = true;

    const rel = batch.map(f => path.isAbsolute(f) ? path.relative(cwd, f) : f);
    const ts = new Date().toLocaleTimeString();
    console.log(`\n${fmt('cyan', `─── ${ts} ──────────────────────────────────`)}`);
    console.log(fmt('dim', `  changed: ${rel.slice(0, 4).join(', ')}${rel.length > 4 ? ` +${rel.length - 4} more` : ''}`));

    try {
      const result = await runGuardrail({ touchedFiles: rel, config, reviewEngine, cwd });

      for (const phase of result.phases) {
        const icon = phase.status === 'pass' ? fmt('green', '✓')
          : phase.status === 'skip' ? fmt('dim', '–')
          : phase.status === 'warn' ? fmt('yellow', '!')
          : fmt('red', '✗');
        console.log(`  ${icon}  ${phase.phase.padEnd(14)}${fmt('dim', ` ${(phase as {durationMs?: number}).durationMs ?? 0}ms`)}`);
        for (const f of phase.findings) {
          if (f.severity === 'critical' || f.severity === 'warning') {
            const sev = f.severity === 'critical' ? fmt('red', 'CRITICAL') : fmt('yellow', 'WARNING ');
            console.log(`       ${sev}  ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
          }
        }
      }

      const verdict = result.status === 'pass' ? fmt('green', '✓ pass')
        : result.status === 'warn' ? fmt('yellow', '! warn')
        : fmt('red', '✗ fail');
      const cost = result.totalCostUSD !== undefined ? fmt('dim', `  $${result.totalCostUSD.toFixed(4)}`) : '';
      console.log(`\n  ${verdict}${cost}  ${fmt('dim', `${result.durationMs}ms`)}`);
    } catch (err) {
      console.error(fmt('red', `  error: ${err instanceof Error ? err.message : String(err)}`));
    }

    running = false;
    console.log(fmt('dim', '\n  Watching for changes…'));

    if (nextPending.size > 0) {
      const queued = [...nextPending];
      nextPending.clear();
      runBatch(queued);
    }
  };

  const debouncer = makeDebouncer(
    batch => { runBatch(batch); },
    debounceMs,
    (_file, queueSize) => {
      if (!debounceLineShown && !running) {
        process.stdout.write(fmt('dim', `  ⋯ ${queueSize} file(s) queued — reviewing in ${debounceMs}ms…\r`));
        debounceLineShown = true;
      }
    },
  );

  const onEvent = (_event: string, filename: string | null) => {
    if (!filename) return;
    const full = path.isAbsolute(filename) ? filename : path.join(cwd, filename);
    if (isIgnored(full)) return;
    debouncer.schedule(full);
  };

  // fs.watch recursive is supported on macOS/Linux kernel ≥5.1; Windows uses ReadDirectoryChangesW.
  // Alpha limitation: not battle-tested in Docker/container contexts — upgrade to chokidar for beta.
  const watcher = fs.watch(cwd, { recursive: true }, onEvent);

  process.on('SIGINT', () => {
    console.log(fmt('dim', '\n[watch] exiting'));
    watcher.close();
    process.exit(0);
  });

  // Keep the process alive
  await new Promise<void>(() => { /* never resolves — watch loop runs until SIGINT */ });
}
