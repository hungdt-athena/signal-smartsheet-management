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
"${P[@]}" -d verify -f scripts/sql-verify/pairs-sync-checks.sql

# Two-session checks. Session A writes, then holds its transaction open until it sees
# session B waiting on a lock (or 10 s pass) and prints whether it saw B wait. The shell
# starts B only once A holds its lock, so the order never depends on a sleep.
#   $1 the lock A must hold before B starts (SQL condition on pg_locks l, A's pid is a.pid)
#   $2 A's write   $3 B's write
two_sessions() {
  local out="$TMP/sessA.out"
  PGAPPNAME=verify_sess_a "${P[@]}" -d verify -At -c "BEGIN" -c "$2" \
    -c "DO \$\$ BEGIN FOR i IN 1..400 LOOP
          EXIT WHEN EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted);
          PERFORM pg_sleep(0.025);
        END LOOP; END \$\$" \
    -c "SELECT 'saw_waiter=' || EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted)" \
    -c "COMMIT" >"$out" &
  local a=$!
  local held=0
  for _ in $(seq 1 400); do
    held=$("${P[@]}" -d verify -At -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                                         WHERE a.application_name = 'verify_sess_a' AND l.granted AND ($1)")
    [ "$held" -gt 0 ] && break
    sleep 0.025
  done
  [ "$held" -gt 0 ] || { echo "session A never took its lock"; exit 1; }
  "${P[@]}" -d verify -c "$3"
  wait "$a"
  grep -qx 'saw_waiter=true' "$out" || { echo "session B never waited on A: $(cat "$out")"; exit 1; }
}

# Two sessions push the 2 stores of a new family: B's trigger waits on A's family lock,
# then sees A's committed row and links. Without the lock B would miss A's row.
"${P[@]}" -d verify -c "INSERT INTO game_info (game_id, os, family_id) VALUES ('ca', 'android', 'fam.cc'), ('ci', 'ios', 'fam.cc')"
two_sessions "l.locktype = 'advisory'" \
  "INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('ca', 'puzzle', 'ThuDT')" \
  "INSERT INTO game_evaluations (game_id, category_group) VALUES ('ci', 'puzzle')"
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('ca', 'ci') AND pair_eval_id IS NOT NULL) = 2, 'concurrent push linked';
  ASSERT (SELECT initial_evaluator FROM game_evaluations WHERE game_id = 'ci') = 'ThuDT', 'B took A''s holder';
END \$\$;"

# Two people save two different columns of one linked pair at the same time, each on
# their own store's row: A's copy reaches B's row first, B waits for it, then B's copy
# carries only its own column. Neither save is lost.
"${P[@]}" -d verify -c "INSERT INTO game_info (game_id, os, family_id) VALUES ('ka', 'android', 'fam.kk'), ('ki', 'ios', 'fam.kk')" \
  -c "INSERT INTO game_evaluations (game_id, category_group, initial_evaluator) VALUES ('ka', 'puzzle', 'ThuDT')" \
  -c "INSERT INTO game_evaluations (game_id, category_group) VALUES ('ki', 'puzzle')"
two_sessions "l.locktype = 'transactionid'" \
  "UPDATE game_evaluations SET initial_note = 'note from A 123' WHERE game_id = 'ka'" \
  "UPDATE game_evaluations SET final_note = 'final from B' WHERE game_id = 'ki'"
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('ka', 'ki') AND pair_eval_id IS NOT NULL
            AND initial_note = 'note from A 123' AND final_note = 'final from B') = 2, 'concurrent saves both kept';
END \$\$;"

# Re-running the migration on a DB full of linked, unlinked and rejected pairs changes
# nothing: the safe-pair pass runs with the sync trigger installed.
snap() { "${P[@]}" -d verify -At -c "SELECT md5(string_agg(to_jsonb(g)::text, ',' ORDER BY id)) FROM game_evaluations g" \
                                  -c "SELECT count(*) FROM evaluation_log"; }
before=$(snap)
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql >/dev/null
[ "$(snap)" = "$before" ] || { echo "re-running 054 changed game_evaluations or evaluation_log"; exit 1; }

echo "eval pairs SQL checks: OK"
