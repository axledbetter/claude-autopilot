import * as fs from 'node:fs';
import * as path from 'node:path';

export function resolveWorkspace(cwd?: string): string {
  return fs.realpathSync(cwd ?? process.cwd());
}

export function assertInWorkspace(workspace: string, filePath: string): string {
  const resolvedWorkspace = fs.realpathSync(workspace);
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(resolvedWorkspace, filePath);

  let resolved: string;
  try {
    resolved = fs.realpathSync(abs);
  } catch {
    // File doesn't exist yet — check the directory
    const dir = path.dirname(abs);
    let resolvedDir: string;
    try {
      resolvedDir = fs.realpathSync(dir);
    } catch {
      // Parent directory doesn't exist — resolve what we can
      resolvedDir = path.resolve(dir);
    }
    resolved = path.join(resolvedDir, path.basename(abs));
  }

  const root = resolvedWorkspace.endsWith(path.sep) ? resolvedWorkspace : resolvedWorkspace + path.sep;
  if (!resolved.startsWith(root) && resolved !== resolvedWorkspace) {
    throw new Error(`Path "${filePath}" is outside workspace "${workspace}"`);
  }
  return resolved;
}
