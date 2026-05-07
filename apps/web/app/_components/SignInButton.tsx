'use client';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function SignInButton() {
  const onClick = async () => {
    // Preserve return-to-page intent through the OAuth round-trip (codex
    // plan-review WARNING: SignInButton omitted next, so users always
    // landed on `/` post-auth). The callback handler applies safeRedirect
    // to whitelist allowed paths.
    const supabase = createSupabaseBrowserClient();
    const origin = window.location.origin;
    const here = window.location.pathname + window.location.search;
    const next = here && here !== '/' ? `?next=${encodeURIComponent(here)}` : '';
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${origin}/api/auth/callback${next}` },
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-6 py-3 rounded-md bg-white text-black font-medium hover:bg-zinc-200 transition"
    >
      Sign in with Google
    </button>
  );
}
