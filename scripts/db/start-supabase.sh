#!/usr/bin/env bash
# Start the local Supabase stack via Docker. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec npx supabase start --workdir db "$@"
