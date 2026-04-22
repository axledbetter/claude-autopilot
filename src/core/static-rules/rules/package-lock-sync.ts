import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticRule } from '../../phases/static-rules.ts';
import type { Finding } from '../../findings/types.ts';

export const packageLockSyncRule: StaticRule = {
  name: 'package-lock-sync',
  severity: 'warning',

  async check(touchedFiles: string[]): Promise<Finding[]> {
    const cwd = process.cwd();
    const hasPkg = touchedFiles.some(f => f === 'package.json');
    const hasLock = touchedFiles.some(f => f === 'package-lock.json');

    if (!hasPkg && !hasLock) return [];

    const pkgExists = fs.existsSync(path.join(cwd, 'package.json'));
    const lockExists = fs.existsSync(path.join(cwd, 'package-lock.json'));

    if (!pkgExists) return [];

    // package.json changed but lock didn't
    if (hasPkg && !hasLock && lockExists) {
      return [{
        id: 'package-lock-sync:package.json',
        source: 'static-rules',
        severity: 'warning',
        category: 'package-lock-sync',
        file: 'package.json',
        message: 'package.json changed but package-lock.json was not updated',
        suggestion: 'Run npm install to sync the lockfile',
        protectedPath: false,
        createdAt: new Date().toISOString(),
      }];
    }

    // lock changed but package.json didn't (unusual, flag it)
    if (hasLock && !hasPkg) {
      return [{
        id: 'package-lock-sync:package-lock.json',
        source: 'static-rules',
        severity: 'warning',
        category: 'package-lock-sync',
        file: 'package-lock.json',
        message: 'package-lock.json changed without a corresponding package.json change',
        suggestion: 'Verify this is intentional — lockfile-only changes can indicate manual edits',
        protectedPath: false,
        createdAt: new Date().toISOString(),
      }];
    }

    return [];
  },
};
