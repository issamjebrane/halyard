#!/usr/bin/env bash
# Local stand-in for pg_cron: hit the verify function every POLL_SECONDS.
# Usage: bash scripts/poll-local.sh
set -euo pipefail

POLL_SECONDS="${POLL_SECONDS:-45}"
FN_URL="${FN_URL:-http://127.0.0.1:54321/functions/v1/verify}"

# Local service-role key (read from `supabase status`), falls back to env.
KEY="${SUPABASE_SERVICE_ROLE_KEY:-$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY=//p' | tr -d '"')}"

echo "polling $FN_URL every ${POLL_SECONDS}s (ctrl-c to stop)"
while true; do
  curl -s -X POST "$FN_URL" \
    -H "Authorization: Bearer ${KEY}" \
    -H "Content-Type: application/json" \
    -d '{}' || true
  echo ""
  sleep "$POLL_SECONDS"
done
