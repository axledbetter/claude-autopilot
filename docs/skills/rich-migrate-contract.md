# Rich migrate skill contract

Skills that implement the rich migrate variant (e.g. `migrate.supabase@1`) follow the canonical envelope/result contract so the autopilot dispatcher can orchestrate them generically.

## Inputs (read by the skill)

The dispatcher passes the invocation envelope via:
- Env var `AUTOPILOT_ENVELOPE` (JSON string)
- (Recommended) stdin JSON for streaming

```json
{
  "contractVersion": "1.0",
  "invocationId": "<uuid v4>",
  "nonce": "<32-byte hex>",
  "trigger": "cli" | "ci",
  "attempt": 1,
  "repoRoot": "/abs/path",
  "cwd": "/abs/path",
  "changedFiles": ["data/deltas/20260429_add_status.sql"],
  "env": "dev",
  "dryRun": false,
  "ci": false,
  "gitBase": "<sha>",
  "gitHead": "<sha>",
  "projectId": "optional-monorepo-package-id"
}
```

The dispatcher also passes:
- `AUTOPILOT_RESULT_PATH` — file path where the skill must write the result artifact
- (When `migrate.<skill>.env_file` is configured) every variable from that file, in the spawn env map (not on the command line)

## Outputs (written by the skill)

Write the result artifact JSON to `AUTOPILOT_RESULT_PATH`. (Optional: also emit nonce-bound stdout markers if `stdoutFallback: true` in manifest.)

```json
{
  "contractVersion": "1.0",
  "skillId": "migrate.supabase@1",
  "invocationId": "<echoed from envelope>",
  "nonce": "<echoed from envelope>",
  "status": "applied" | "skipped" | "validation-failed" | "needs-human" | "error",
  "reasonCode": "<enum-like short string>",
  "appliedMigrations": ["20260429_add_status.sql"],
  "destructiveDetected": false,
  "sideEffectsPerformed": ["migration-ledger-updated", "types-regenerated"],
  "nextActions": ["regenerate-types"]
}
```

### Required fields

All fields above are required. Missing fields → dispatcher reports `reasonCode: invalid-result-artifact`.

### Reserved `sideEffectsPerformed` vocabulary

Skills cannot invent values. The v1 enum:
- `types-regenerated` — type files (e.g. supabase types, prisma generate output) were updated
- `migration-ledger-updated` — a migration ledger row was written
- `schema-cache-refreshed` — cached schema metadata invalidated
- `seed-data-applied` — seed/fixture data inserted
- `snapshot-written` — a backup/snapshot was created
- `no-side-effects` — explicit signal of no side effects (use when status is skipped)

### Reserved `nextActions`

These influence pipeline behavior. Implementations:
- `regenerate-types` — pipeline runs `npm run typecheck` after this skill
- `human-review` — pipeline halts and notifies the user

Other values are accepted as forward-compat hints but treated as advisory.

### Identity binding

`invocationId` and `nonce` MUST be echoed verbatim from the envelope. The dispatcher rejects mismatches with `nonce-mismatch` / `invocationId-mismatch` reason codes.

## Exit codes

The skill's process exit code is informational only — the result artifact is the source of truth. Recommended:
- `0` for any `status: applied | skipped`
- Non-zero for `status: error`

## Stdout fallback

By default, the skill MUST write the result file. If the skill cannot reliably write the file (rare — embedded contexts, sandboxed environments), set `stdoutFallback: true` in the manifest and emit:

```
@@AUTOPILOT_RESULT_BEGIN:<nonce>@@
{...JSON...}
@@AUTOPILOT_RESULT_END:<nonce>@@
```

The nonce in the markers MUST match the envelope. Mismatched nonce is silently ignored (defends against subprocess output spoofing).

## Audit log

Every dispatch generates a JSONL audit log entry at `.autopilot/audit.log` with monotonic seq + SHA-256 prev_hash chain. Skills do NOT write to this directly; the dispatcher records the call.

## Example minimal implementation

```bash
#!/bin/bash
ENVELOPE="$AUTOPILOT_ENVELOPE"
NONCE=$(echo "$ENVELOPE" | jq -r .nonce)
INVOCATION_ID=$(echo "$ENVELOPE" | jq -r .invocationId)

# ... do migration work ...

cat > "$AUTOPILOT_RESULT_PATH" <<EOF
{
  "contractVersion": "1.0",
  "skillId": "my-skill@1",
  "invocationId": "$INVOCATION_ID",
  "nonce": "$NONCE",
  "status": "applied",
  "reasonCode": "ok",
  "appliedMigrations": [],
  "destructiveDetected": false,
  "sideEffectsPerformed": ["no-side-effects"],
  "nextActions": []
}
EOF
```
