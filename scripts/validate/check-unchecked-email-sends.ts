import type { Finding } from './types';

type PartialFinding = Omit<Finding, 'id' | 'phase' | 'status' | 'fixAttempted' | 'fixCommitSha' | 'protectedPath'>;

/**
 * Stub — replace with your own unhandled-async-send checks.
 *
 * Example: AST scan to ensure every call to emailService.send() has its
 * return value awaited or .catch()-ed so failures aren't silently dropped.
 * Return PartialFinding[] (id/phase/status fields are filled in by the caller).
 */
export async function checkUncheckedEmailSends(): Promise<PartialFinding[]> {
  return [];
}
