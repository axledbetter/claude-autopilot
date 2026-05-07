type Fn<T> = () => Promise<T>;

let testHook: ((jti: string, fn: Fn<unknown>) => Promise<unknown>) | null = null;

export function _setTransactionHookForTests(hook: typeof testHook): void { testHook = hook; }

export async function withSessionTransaction<T>(jti: string, fn: Fn<T>): Promise<T> {
  if (testHook) return testHook(jti, fn as Fn<unknown>) as Promise<T>;
  // Prod: rely on (a) consumed_at single-column UPDATE as the CAS marker
  // and (b) Storage upsert:false byte-equality verification.
  // No advisory lock needed — Storage idempotency handles the duplicate
  // submission case correctly.
  return fn();
}
