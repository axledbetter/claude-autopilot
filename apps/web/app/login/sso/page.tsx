// /login/sso — Phase 5.6.
//
// Email-input form. Submits to /api/auth/sso/start; on success navigates
// to the returned authorizationUrl. Renders a banner when redirected
// here from /api/auth/callback with reason=sso_required.

import SsoSignInForm from '@/components/auth/SsoSignInForm';

export const dynamic = 'force-dynamic';

interface SearchParams { email?: string; reason?: string }

export default async function SsoLoginPage(
  { searchParams }: { searchParams: Promise<SearchParams> },
): Promise<React.ReactElement> {
  const sp = await searchParams;
  return (
    <div className="max-w-md mx-auto py-12 px-6 flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Sign in with SSO</h1>
      {sp.reason === 'sso_required' && (
        <div className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded p-3">
          Your organization requires SSO sign-in. Enter your work email below.
        </div>
      )}
      <p className="text-sm opacity-70">
        Enter your work email. We&apos;ll redirect you to your identity provider.
      </p>
      <SsoSignInForm initialEmail={sp.email ?? ''} />
    </div>
  );
}
