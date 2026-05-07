import { createSupabaseServerClient } from '@/lib/supabase/server';
import SignInButton from './_components/SignInButton';
import SignOutButton from './_components/SignOutButton';

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold mb-2">claude-autopilot</h1>
      <p className="opacity-60 mb-8 text-center max-w-prose">
        Local-first agentic dev workflows. Free forever for individuals.
      </p>
      {params.error ? (
        <div className="bg-red-500/10 border border-red-500/40 text-red-300 px-4 py-2 rounded mb-6">
          Auth error: {params.error}
        </div>
      ) : null}
      {user ? (
        <div className="flex flex-col items-center gap-4">
          <p>Welcome, {user.email}</p>
          <SignOutButton />
        </div>
      ) : (
        <SignInButton />
      )}
    </main>
  );
}
