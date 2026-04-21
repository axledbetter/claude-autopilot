import * as fs from 'node:fs';
import * as path from 'node:path';

const HOOK_CONTENT = `#!/bin/sh
# autopilot pre-push hook — runs impact-selected snapshots before push
npx tsx scripts/autoregress.ts run
`;

function findGitDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function runHook(
  sub: string,
  options: { cwd?: string; force?: boolean } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const gitDir = findGitDir(cwd);

  if (!gitDir) {
    console.error('[hook] not inside a git repository');
    return 1;
  }

  const hookPath = path.join(gitDir, 'hooks', 'pre-push');

  switch (sub) {
    case 'install': {
      if (fs.existsSync(hookPath) && !options.force) {
        console.error(`[hook] pre-push hook already exists at ${hookPath}`);
        console.error('       Use --force to overwrite.');
        return 1;
      }
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, HOOK_CONTENT, 'utf8');
      fs.chmodSync(hookPath, 0o755);
      console.log(`[hook] installed pre-push hook at ${hookPath}`);
      return 0;
    }
    case 'uninstall': {
      if (!fs.existsSync(hookPath)) {
        console.log('[hook] no pre-push hook installed');
        return 0;
      }
      fs.rmSync(hookPath);
      console.log(`[hook] removed ${hookPath}`);
      return 0;
    }
    case 'status': {
      if (fs.existsSync(hookPath)) {
        console.log(`[hook] installed at ${hookPath}`);
        console.log(fs.readFileSync(hookPath, 'utf8'));
      } else {
        console.log('[hook] not installed');
      }
      return 0;
    }
    default:
      console.error(`[hook] unknown subcommand: ${sub}`);
      console.error('Usage: autopilot hook <install|uninstall|status> [--force]');
      return 1;
  }
}
