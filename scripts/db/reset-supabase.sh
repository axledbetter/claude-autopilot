#!/usr/bin/env bash
# Drop the local DB, recreate it, reapply all migrations.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec npx supabase db reset --workdir db "$@"
