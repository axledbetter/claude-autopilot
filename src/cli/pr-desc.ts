import type { Finding } from '../core/findings/types.ts';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

export interface PrDescOptions {
  base?: string;
  post?: boolean;
  yes?: boolean;
  output?: string;
  _gitDiff?: string;
  _branchName?: string;
  _cachedFindings?: Finding[];
  _reviewEngine?: {
    review(input: { content: string; kind: string }): Promise<{ rawOutput: string }>;
  };
}

export interface PrDescResult {
  title: string;
  body: string;
  prUrl?: string;
}

export function truncateDiff(diff: string, charLimit = 6000): string {
  if (diff.length <= charLimit) return diff;
  const remaining = diff.length - charLimit;
  return `${diff.slice(0, charLimit)}[...truncated ${remaining} chars]`;
}

export function summarizeFindings(findings: Finding[], max = 10): string {
  if (findings.length === 0) return 'None';
  const order: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9),
  );
  return sorted
    .slice(0, max)
    .map(f => `- [${f.severity.toUpperCase()}] ${f.file}:${f.line ?? '?'} — ${f.message}`)
    .join('\n');
}

export function parseDescription(raw: string): { title: string; body: string } {
  const titleMatch = raw.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'chore: update';
  const sepIdx = raw.indexOf('\n\n---\n');
  const body = sepIdx !== -1 ? raw.slice(sepIdx + 5).trim() : raw.replace(/^Title:.*\n?/m, '').trim();
  return { title, body };
}

export async function runPrDesc(options: PrDescOptions): Promise<PrDescResult> {
  const branchName = options._branchName ?? getBranchName();
  const diff = options._gitDiff ?? getGitDiff(options.base);

  if (!diff.trim()) {
    process.stdout.write('No changes detected\n');
    return { title: 'No changes detected', body: '' };
  }

  const findings = options._cachedFindings ?? loadCachedFindings();
  const prompt = buildPrompt(branchName, truncateDiff(diff), summarizeFindings(findings));

  const engine = options._reviewEngine ?? (await resolveEngine());
  const { rawOutput } = await engine.review({ content: prompt, kind: 'pr-diff' });
  const { title, body } = parseDescription(rawOutput);

  const formatted = `Title: ${title}\n\n---\n${body}`;

  if (options.output) {
    fs.writeFileSync(options.output, formatted, 'utf8');
  } else {
    process.stdout.write(formatted + '\n');
  }

  if (options.post) {
    return createPr(title, body, options.yes ?? false);
  }

  return { title, body };
}

function getBranchName(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitDiff(base?: string): string {
  try {
    const ref = base ?? getUpstreamBase();
    return execSync(`git diff ${ref}...HEAD`, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function getUpstreamBase(): string {
  try {
    return execSync(
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'HEAD~1';
  }
}

function loadCachedFindings(): Finding[] {
  try {
    return JSON.parse(fs.readFileSync('.guardrail-cache/findings.json', 'utf8')) as Finding[];
  } catch {
    return [];
  }
}

function buildPrompt(branch: string, diff: string, findingsSummary: string): string {
  return `Generate a pull request description with three sections:

## Summary
<3-5 bullet points describing what changed and why>

## Changes
<grouped by file/area, concise>

## Test Plan
<checklist of what to verify before merging>

Branch: ${branch}
Diff:
${diff}

Guardrail findings in this diff:
${findingsSummary}`;
}

async function resolveEngine() {
  const { loadAdapter } = await import('../adapters/review-engine/loader.ts');
  const { loadConfig } = await import('../core/config/loader.ts');
  const cfg = await loadConfig(undefined);
  return loadAdapter(cfg.reviewEngine);
}

async function createPr(title: string, body: string, yes: boolean): Promise<PrDescResult> {
  if (!yes) {
    process.stdout.write('\nCreate PR with this description? [y/N] ');
    const answer = await new Promise<string>(resolve => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk: string) => resolve(chunk.split('\n')[0]));
    });
    if (!answer.toLowerCase().startsWith('y')) return { title, body };
  }
  const prUrl = execSync(
    `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
    { encoding: 'utf8' },
  ).trim();
  process.stdout.write(`\nPR created: ${prUrl}\n`);
  return { title, body, prUrl };
}
