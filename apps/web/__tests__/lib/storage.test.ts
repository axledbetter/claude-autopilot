import { describe, it, expect } from 'vitest';
import { chunkPath, manifestPath, statePath } from '@/lib/upload/storage';

describe('storage path helpers', () => {
  const orgScope = { organizationId: 'org1', userId: 'u1' };
  const freeScope = { organizationId: null, userId: 'u1' };

  it('routes org-tier paths under org/<id>', () => {
    expect(chunkPath(orgScope, 'r1', 0)).toBe('org/org1/r1/events/0.ndjson');
    expect(manifestPath(orgScope, 'r1')).toBe('org/org1/r1/events.index.json');
    expect(statePath(orgScope, 'r1')).toBe('org/org1/r1/state.json');
  });

  it('routes free-tier paths under user/<id>', () => {
    expect(chunkPath(freeScope, 'r1', 5)).toBe('user/u1/r1/events/5.ndjson');
  });
});
