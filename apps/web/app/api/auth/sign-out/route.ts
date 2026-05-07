// apps/web/app/api/auth/sign-out/route.ts
//
// Clears the Supabase session for the configured project ref.
//
// Codex final-pass WARNING #2: do NOT use a wildcard sb-* sweep. On shared
// parent domains (local dev, preview, staging, prod, plus other Supabase
// projects), a wildcard delete clears unrelated cookies and causes hard-to-
// debug cross-app session bugs. We delete only cookies matching
// sb-<NEXT_PUBLIC_SUPABASE_PROJECT_REF>-auth-token (and chunked variants).

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  // Belt-and-suspenders cookie clear scoped to the configured project.
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF;
  if (projectRef) {
    const cookieStore = await cookies();
    const targetPrefix = `sb-${projectRef}-auth-token`;
    for (const c of cookieStore.getAll()) {
      if (c.name === targetPrefix || c.name.startsWith(`${targetPrefix}.`)) {
        cookieStore.delete(c.name);
      }
    }
  }

  // 303 See Other so the browser issues GET /, not POST /.
  return NextResponse.redirect(new URL('/', url.origin), { status: 303 });
}
