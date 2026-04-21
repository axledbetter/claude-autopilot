import type { Finding } from '../../../src/core/findings/types.ts';
import type { StaticRule } from '../../../src/core/phases/static-rules.ts';

export const fakeCleanRule: StaticRule = {
  name: 'fake-clean', severity: 'warning',
  async check() { return []; },
};

export const fakeCriticalRule: StaticRule = {
  name: 'fake-critical', severity: 'critical',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fc-1', source: 'static-rules', severity: 'critical',
      category: 'fake-critical', file: files[0]!,
      message: 'fake critical', protectedPath: false,
      createdAt: new Date().toISOString(),
    }];
  },
};

export const fakeAutofixingRule: StaticRule = {
  name: 'fake-autofix', severity: 'warning',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fa-1', source: 'static-rules', severity: 'warning',
      category: 'fake-autofix', file: files[0]!,
      message: 'fake autofixable warning', protectedPath: false,
      createdAt: new Date().toISOString(),
    }];
  },
  async autofix() { return 'fixed'; },
};

export const fakeProtectedAutofixRule: StaticRule = {
  name: 'fake-protected-autofix', severity: 'warning',
  async check(files: string[]): Promise<Finding[]> {
    if (files.length === 0) return [];
    return [{
      id: 'fp-1', source: 'static-rules', severity: 'warning',
      category: 'fake-protected-autofix', file: files[0]!,
      message: 'warning on protected path', protectedPath: true,
      createdAt: new Date().toISOString(),
    }];
  },
  async autofix() { return 'fixed'; },
};
