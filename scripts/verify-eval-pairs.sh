#!/usr/bin/env bash
# Runs migration 054 (Playtest store pairs) and its SQL checks against a THROWAWAY local
# Postgres. Never reads DATABASE_URL or .env files and never touches another database:
# the schema it needs is the static scripts/sql-verify/pairs-schema.sql. Uses Homebrew
# postgresql@16 when installed (the sample DB is 16), else whatever is on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/local/opt/postgresql@16/bin:$PATH"
TMP=$(mktemp -d)
PORT=${VERIFY_PG_PORT:-54328}
cleanup() { pg_ctl -D "$TMP/pg" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
initdb -D "$TMP/pg" -U postgres --auth=trust >/dev/null
pg_ctl -D "$TMP/pg" -o "-p $PORT -k $TMP -c listen_addresses=127.0.0.1 -c timezone=UTC" -l "$TMP/pg.log" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"   # hide idempotent "already exists" notices
P=(psql -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "CREATE DATABASE verify"
"${P[@]}" -d verify -f scripts/sql-verify/pairs-schema.sql
"${P[@]}" -d verify -f migrations/046_evaluation_log.sql
"${P[@]}" -d verify -f migrations/047_evaluation_log_demo_added.sql
# twice: the migration must be safe to re-run
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql
"${P[@]}" -d verify -f scripts/sql-verify/pairs-link-checks.sql
# Two sessions push the 2 stores of a new family: B's trigger waits on A's family lock,
# then sees A's committed row and links. Without the lock B would miss A's row.
"${P[@]}" -d verify -c "INSERT INTO game_info (game_id, os, family_id) VALUES ('ca', 'android', 'fam.cc'), ('ci', 'ios', 'fam.cc')"
"${P[@]}" -d verify -c "BEGIN" \
  -c "INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('ca', 'puzzle', 'ThuDT')" \
  -c "SELECT pg_sleep(2)" -c "COMMIT" >/dev/null &
A=$!
sleep 0.5
"${P[@]}" -d verify -c "INSERT INTO game_evaluations (game_id, category_group) VALUES ('ci', 'puzzle')"
wait $A
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('ca', 'ci') AND pair_eval_id IS NOT NULL) = 2, 'concurrent push linked';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE game_id = 'ci') = 'ThuDT', 'B took A''s holder';
END \$\$;"
echo "eval pairs SQL checks: OK"
