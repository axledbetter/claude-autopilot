A generic project with no strong framework signals detected.

This preset makes **no assumptions** about:
- Database engine or migration runner
- Type generation
- Test framework (uses whatever `npm test` / `npm run typecheck` / `npm run lint` find)
- Deployment target

It enables the core security rules that apply to most codebases — hardcoded secrets, npm audit, SQL injection patterns, missing auth checks, SSRF, insecure redirects.

## What's disabled vs stack-specific presets

- `supabase-rls-bypass` rule (Supabase-only)
- `schema-alignment` rule (requires declared migration paths)
- `migrate` phase of the pipeline no-ops with a notice

## Wiring up migrations

If your project uses migrations, create `.claude-autopilot/stack.yaml` with:

```yaml
migrate:
  command: "prisma migrate dev"      # or flyway, dbmate, tbls, golang-migrate, etc.
  environments: [dev, staging, prod]
  typeGeneration:
    command: "prisma generate"
    path: "node_modules/.prisma/client"
```

Or pick a stack-specific preset at setup time: `claude-autopilot init --preset nextjs-supabase`.

## Things that should flag CRITICAL (universal)

- Secrets committed to code or history
- SQL string concatenation with user input
- POST endpoints without auth checks
- SSRF via user-controlled URLs in `fetch` / `axios`
- Open redirects (user-controlled `Location` header)
- Dynamic code evaluation (`eval`, `Function` constructor) with user input
- Shell command construction with user input
