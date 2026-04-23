const mutexes = new Map<string, Promise<void>>();

export async function withWriteLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  let unlock!: () => void;
  const current = new Promise<void>(resolve => { unlock = resolve; });
  const prev = mutexes.get(workspace) ?? Promise.resolve();
  mutexes.set(workspace, current);

  await prev;
  try {
    return await fn();
  } finally {
    unlock();
    if (mutexes.get(workspace) === current) mutexes.delete(workspace);
  }
}
