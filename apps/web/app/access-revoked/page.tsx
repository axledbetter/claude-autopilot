// /access-revoked — Phase 6 (codex pass-1 WARNING #4).
//
// Static Server Component shown when the dashboard middleware revokes a
// session because the user's membership is no longer active. The
// middleware redirects here with `?reason=<member_disabled|
// member_inactive|no_membership|check_failed>` AFTER clearing the
// `cao_active_org` and `cao_membership_check` cookies.
//
// Why a dedicated page (NOT /login):
//   /login auto-forwards already-authenticated users back to /dashboard
//   via the existing session check, so a revoked user would loop. This
//   page does NOT auto-forward; it always renders the message + a
//   Sign-out form that POSTs to /api/auth/sign-out.

import React from 'react';

export const dynamic = 'force-dynamic';

type Reason = 'member_disabled' | 'member_inactive' | 'no_membership' | 'check_failed';

interface SearchParams {
  reason?: string;
}

const REASON_TITLE: Record<Reason, string> = {
  member_disabled: 'Your account has been disabled',
  member_inactive: 'Your account is inactive',
  no_membership: 'No active organization',
  check_failed: 'Membership check unavailable',
};

const REASON_BODY: Record<Reason, string> = {
  member_disabled:
    'An administrator disabled your account in this organization. ' +
    'Contact the organization owner if this was unexpected.',
  member_inactive:
    'Your membership in this organization is not currently active. ' +
    'Contact the organization owner to be reactivated.',
  no_membership:
    'You no longer have an active membership in this organization. ' +
    'Sign out and sign back in to choose a different organization.',
  check_failed:
    'We could not verify your membership status. ' +
    'This is usually a temporary backend issue — please sign out, wait a moment, and sign back in. ' +
    'If the problem persists, contact support.',
};

function normalizeReason(raw: string | undefined): Reason {
  if (raw === 'member_disabled' || raw === 'member_inactive' || raw === 'no_membership' || raw === 'check_failed') {
    return raw;
  }
  return 'no_membership';
}

export default async function AccessRevokedPage(
  { searchParams }: { searchParams: Promise<SearchParams> },
): Promise<React.ReactElement> {
  const sp = await searchParams;
  const reason = normalizeReason(sp.reason);
  return (
    <div className="max-w-md mx-auto py-12 px-6 flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{REASON_TITLE[reason]}</h1>
      <p className="text-sm text-zinc-300">{REASON_BODY[reason]}</p>
      <form method="POST" action="/api/auth/sign-out">
        <button
          type="submit"
          className="rounded bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-white"
        >
          Sign out
        </button>
      </form>
      <p className="text-xs text-zinc-500" data-testid="access-revoked-reason">
        reason: {reason}
      </p>
    </div>
  );
}
