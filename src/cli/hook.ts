import * as fs from 'node:fs';
import * as path from 'node:path';

export const GUARDRAIL_MARKER = '# guardrail-managed';

const PRE_COMMIT_TEMPLATE = `#!/bin/sh
${GUARDRAIL_MARKER}
# guardrail pre-commit hook — runs static rules only (<1s, no LLM)
STAGED=$(git diff --cached --name-only --diff-filter=ACM | tr '\\n' ' ')
if [ -z "$STAGED" ]; then exit 0; fi
npx guardrail run --static-only --files $STAGED
`;

const PRE_PUSH_TEMPLATE = `#!/bin/sh
${GUARDRAIL_MARKER}
# guardrail pre-push hook — full LLM review against upstream
BASE=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "HEAD~1")
npx guardrail run --base $BASE
`;

function findGitDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const content = fs.readFileSync(candidate, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)/m);
        if (match) return path.resolve(dir, match[1]!.trim());
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function isGuardrailHook(hookPath: string): boolean {
  try {
    return fs.readFileSync(hookPath, 'utf8').includes(GUARDRAIL_MARKER);
  } catch {
    return false;
  }
}

function writeHook(hookPath: string, content: string, force: boolean): boolean {
  if (fs.existsSync(hookPath) && !force && !isGuardrailHook(hookPath)) {
    console.error(`[hook] hook already exists at ${hookPath} (not guardrail-managed)`);
    console.error('       Use --force to overwrite.');
    return false;
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, content, 'utf8');
  fs.chmodSync(hookPath, 0o755);
  return true;
}

function removeHook(hookPath: string): void {
  if (!fs.existsSync(hookPath)) return;
  if (isGuardrailHook(hookPath)) {
    fs.rmSync(hookPath);
    console.log(`[hook] removed ${hookPath}`);
  } else {
    console.log(`[hook] skipping ${hookPath} — not guardrail-managed`);
  }
}

export async function runHook(
  sub: string,
  options: { cwd?: string; force?: boolean; silent?: boolean; preCommitOnly?: boolean; prePushOnly?: boolean } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const gitDir = findGitDir(cwd);

  if (!gitDir) {
    if (!options.silent) console.error('[hook] not inside a git repository');
    return 1;
  }

  const hooksDir = path.join(gitDir, 'hooks');
  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const prePushPath = path.join(hooksDir, 'pre-push');
  const force = options.force ?? false;

  switch (sub) {
    case 'install': {
      const installPreCommit = !options.prePushOnly;
      const installPrePush = !options.preCommitOnly;
      let ok = true;
      if (installPreCommit) {
        const written = writeHook(preCommitPath, PRE_COMMIT_TEMPLATE, force);
        if (written) console.log(`[hook] installed pre-commit hook at ${preCommitPath}`);
        else ok = false;
      }
      if (installPrePush) {
        const written = writeHook(prePushPath, PRE_PUSH_TEMPLATE, force);
        if (written) console.log(`[hook] installed pre-push hook at ${prePushPath}`);
        else ok = false;
      }
      return ok ? 0 : 1;
    }
    case 'uninstall': {
      removeHook(preCommitPath);
      removeHook(prePushPath);
      return 0;
    }
    case 'status': {
      const pcInstalled = fs.existsSync(preCommitPath) && isGuardrailHook(preCommitPath);
      const ppInstalled = fs.existsSync(prePushPath) && isGuardrailHook(prePushPath);
      console.log(`[hook] pre-commit: ${pcInstalled ? 'installed (guardrail-managed)' : 'not installed'}`);
      console.log(`[hook] pre-push:   ${ppInstalled ? 'installed (guardrail-managed)' : 'not installed'}`);
      return 0;
    }
    default:
      console.error(`[hook] unknown subcommand: ${sub}`);
      console.error('Usage: guardrail hook <install|uninstall|status> [--force] [--pre-commit-only] [--pre-push-only]');
      return 1;
  }
}
