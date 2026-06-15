#!/usr/bin/env bash
# Run SQL against the PRODUCTION Supabase database directly — no Docker, no local
# stack. Reads the project ref (from NEXT_PUBLIC_SUPABASE_URL) and the database
# password (databasePassword) out of .env.local.
#
#   ./scripts/psql-prod.sh -c "select count(*) from public.signals;"
#   ./scripts/psql-prod.sh -f scripts/ratchet-verify.sql
#
# Tip: verify engine/SQL changes inside a ROLLBACK transaction (see
# scripts/ratchet-verify.sql) so nothing is ever persisted.
set -euo pipefail
cd "$(dirname "$0")/.."

PW=$(sed -n 's/^databasePassword=//p' .env.local)
REF=$(sed -n 's#^NEXT_PUBLIC_SUPABASE_URL=https://\([a-z0-9]*\)\.supabase\.co#\1#p' .env.local)
HOST="${SUPABASE_DB_HOST:-aws-1-eu-central-1.pooler.supabase.com}"
PORT="${SUPABASE_DB_PORT:-5432}"

if [ -z "$PW" ] || [ -z "$REF" ]; then
  echo "Could not read databasePassword / project ref from .env.local" >&2
  exit 1
fi

PGPASSWORD="$PW" psql \
  "host=$HOST port=$PORT user=postgres.$REF dbname=postgres sslmode=require connect_timeout=10" \
  "$@"
