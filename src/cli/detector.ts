import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DetectionResult {
  preset: string;
  testCommand: string;
  confidence: 'high' | 'low';
  evidence: string;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fileContains(filePath: string, needle: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

const DEFAULT_TEST_PLACEHOLDER = /^echo .error: no test specified/i;

function nodeTestCommand(cwd: string): string {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const scripts = pkg?.['scripts'] as Record<string, string> | undefined;
  const cmd = scripts?.['test'];
  if (!cmd || DEFAULT_TEST_PLACEHOLDER.test(cmd)) return 'npm test';
  return cmd;
}

export function detectProject(cwd: string): DetectionResult {
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { preset: 'go', testCommand: 'go test ./...', confidence: 'high', evidence: 'found go.mod' };
  }

  const gemfile = path.join(cwd, 'Gemfile');
  if (fs.existsSync(gemfile) && fileContains(gemfile, 'rails')) {
    return { preset: 'rails-postgres', testCommand: 'bundle exec rails test', confidence: 'high', evidence: "found Gemfile with 'rails'" };
  }

  const reqTxt = path.join(cwd, 'requirements.txt');
  const pyproject = path.join(cwd, 'pyproject.toml');
  if ((fs.existsSync(reqTxt) && fileContains(reqTxt, 'fastapi')) ||
      (fs.existsSync(pyproject) && fileContains(pyproject, 'fastapi'))) {
    return { preset: 'python-fastapi', testCommand: 'pytest', confidence: 'high', evidence: 'found fastapi in requirements' };
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    const deps = {
      ...(pkg?.['dependencies'] as Record<string, string> ?? {}),
      ...(pkg?.['devDependencies'] as Record<string, string> ?? {}),
    };
    const testCmd = nodeTestCommand(cwd);

    if ('@trpc/server' in deps) {
      return { preset: 't3', testCommand: testCmd, confidence: 'high', evidence: 'found @trpc/server in package.json' };
    }
    if ('next' in deps && '@supabase/supabase-js' in deps) {
      return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'high', evidence: 'found next + @supabase/supabase-js in package.json' };
    }
    if ('next' in deps) {
      return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'low', evidence: 'found next in package.json (no supabase detected)' };
    }
    return { preset: 'nextjs-supabase', testCommand: testCmd, confidence: 'low', evidence: 'found package.json (no strong framework signals)' };
  }

  return { preset: 'nextjs-supabase', testCommand: 'npm test', confidence: 'low', evidence: 'no project signals found — using default preset' };
}
