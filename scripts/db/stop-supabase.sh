#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
exec npx supabase stop --workdir db "$@"
