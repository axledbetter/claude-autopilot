import type { Finding } from './types';

type PartialFinding = Omit<Finding, 'id' | 'phase' | 'status' | 'fixAttempted' | 'fixCommitSha' | 'protectedPath'>;

/**
 * Stub — replace with your own sender domain checks.
 *
 * Example: verify that outbound email service calls only use approved sender domains.
 * Return PartialFinding[] (id/phase/status fields are filled in by the caller).
 */
export async function checkEmailSenderDomains(): Promise<PartialFinding[]> {
  return [];
}
