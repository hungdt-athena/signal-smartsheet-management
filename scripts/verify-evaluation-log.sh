#!/usr/bin/env bash
# Runs migration 045 and the evaluation_log SQL checks against a THROWAWAY local
# Postgres. Never reads DATABASE_URL or .env files. Needs initdb/pg_ctl/psql on PATH
# (Homebrew postgresql@14 or newer).
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
PORT=${VERIFY_PG_PORT:-54329}
cleanup() { pg_ctl -D "$TMP/pg" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
initdb -D "$TMP/pg" -U postgres --auth=trust >/dev/null
# timezone=UTC so the +07 boundary in the seed is really tested, whatever the machine's zone
pg_ctl -D "$TMP/pg" -o "-p $PORT -k $TMP -c listen_addresses=127.0.0.1 -c timezone=UTC" -l "$TMP/pg.log" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"   # hide idempotent "already exists" notices
P=(psql -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "CREATE DATABASE verify"
"${P[@]}" -d verify -f scripts/sql-verify/schema.sql
"${P[@]}" -d verify -f scripts/sql-verify/seed-fixtures.sql
"${P[@]}" -d verify -f migrations/045_evaluation_log.sql
"${P[@]}" -d verify -f scripts/sql-verify/checks.sql
echo "evaluation_log SQL checks: OK"
