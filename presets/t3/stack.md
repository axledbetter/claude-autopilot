A T3 Stack application with:
- Next.js App Router, TypeScript, Tailwind CSS
- tRPC v11 for type-safe APIs (router in src/server/api/)
- Prisma ORM with Postgres (migrations in prisma/migrations/)
- NextAuth.js for authentication
- Zod for input validation

Conventions:
- tRPC procedures live in src/server/api/routers/
- DB access only through Prisma client in src/server/db.ts
- Server-only code uses `server-only` package import guard
- env.js validates all env vars at startup (Zod schema)
- Client components must not import from src/server/

Things that should flag CRITICAL:
- Direct Prisma client usage in client components
- Missing `server-only` guard on server utilities
- tRPC procedure without input validation (Zod)
- Secrets hardcoded in source
- Prisma $executeRaw with unsanitized user input
