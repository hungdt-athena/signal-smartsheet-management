#!/usr/bin/env bash
# Runs migrations 054 + 055 (Playtest store pairs) and their SQL checks against a THROWAWAY local
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

# The schema objects (functions + a hash of their body, relations, triggers + their function,
# indexes, columns, constraints), to prove each ROLLBACK block removes everything its migration
# adds and nothing else, and puts back the function bodies it replaced.
catalog() { "${P[@]}" -d verify -At -c "
  SELECT 'fn ' || p.oid::regprocedure || ' ' || md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  UNION ALL SELECT 'rel ' || c.oid::regclass || ' ' || c.relkind::text FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'trg ' || tgrelid::regclass || ' ' || tgname || ' ' || tgfoid::regproc || ' ' || tgenabled::text
    FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'idx ' || i.indexrelid::regclass FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'col ' || a.attrelid::regclass || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                   || ' ' || a.attnotnull || ' ' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT 'con ' || conrelid::regclass || ' ' || conname FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  ORDER BY 1"; }
catalog_before_054=$(catalog)

# twice: the migration must be safe to re-run
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql
catalog_with_054=$(catalog)
"${P[@]}" -d verify -f scripts/sql-verify/pairs-link-checks.sql
"${P[@]}" -d verify -f scripts/sql-verify/pairs-sync-checks.sql
"${P[@]}" -d verify -f scripts/sql-verify/pairs-unlink-checks.sql

# Two-session checks. Session A writes, then holds its transaction open until it sees
# session B waiting on a lock (or 10 s pass) and prints whether it saw B wait. The shell
# starts B only once A holds its lock AND A's write has finished (A runs its wait loop,
# the DO statement marked verify_wait), so A's triggers, e.g. the copy to the twin, are done before B starts.
# The order never depends on a sleep.
#   $1 the lock A must hold before B starts (SQL condition on pg_locks l, A's pid is a.pid)
#   $2 A's write   $3 B's write
two_sessions() {
  local out="$TMP/sessA.out"
  PGAPPNAME=verify_sess_a "${P[@]}" -d verify -At -c "BEGIN" -c "$2" \
    -c "DO \$\$ /* verify_wait */ BEGIN FOR i IN 1..400 LOOP
          EXIT WHEN EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted);
          PERFORM pg_sleep(0.025);
        END LOOP; END \$\$" \
    -c "SELECT 'saw_waiter=' || EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted)" \
    -c "COMMIT" >"$out" &
  local a=$!
  local held=0
  for _ in $(seq 1 400); do
    held=$("${P[@]}" -d verify -At -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                                         WHERE a.application_name = 'verify_sess_a' AND a.query LIKE '%verify_wait%'
                                           AND l.granted AND ($1)")
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
# The family lock is the two-key form (54, hashtext(family)): classid 54, objsubid 2, so it
# never shares the single-key space other code (Signal Sense) may use.
"${P[@]}" -d verify -c "INSERT INTO game_info (game_id, os, family_id) VALUES ('ca', 'android', 'fam.cc'), ('ci', 'ios', 'fam.cc')"
two_sessions "l.locktype = 'advisory' AND l.classid = 54 AND l.objid = hashtext('fam.cc')::oid AND l.objsubid = 2" \
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

# Waits (up to 10 s) until the SQL count $1 is above 0.
wait_for() {
  local n=0
  for _ in $(seq 1 400); do
    n=$("${P[@]}" -d verify -At -c "$1")
    [ "$n" -gt 0 ] && return 0
    sleep 0.025
  done
  echo "timed out waiting for: $1"; exit 1
}
# A background session that holds $1 (SQL run inside its transaction) until the shell
# inserts a row into verify_go (or 30 s pass).
hold() {
  PGAPPNAME=verify_holder "${P[@]}" -d verify -At -c "BEGIN" -c "$1" \
    -c "DO \$\$ BEGIN FOR i IN 1..1200 LOOP EXIT WHEN EXISTS (SELECT 1 FROM verify_go);
          PERFORM pg_sleep(0.025); END LOOP; END \$\$" -c "COMMIT" >/dev/null &
}
"${P[@]}" -d verify -c "CREATE TABLE verify_go (x int)"

# pass_leaves_game_info_alone: the safe-pair pass holds no lock on Signal Sense's game_info.
# (Reading game_info takes AccessShare / RowShare, which block no Signal Sense INSERT,
# UPDATE or SELECT; the check looks for the modes that would.)
# A test trigger parks the pass on its first pair_link log (advisory lock 4242, held by a
# background session) while a Signal Sense UPDATE of game_info runs with a 2 s lock_timeout.
"${P[@]}" -d verify -c "INSERT INTO game_info (game_id, os) VALUES ('lka', 'android'), ('lki', 'ios')" \
  -c "INSERT INTO game_evaluations (game_id, category_group) VALUES ('lka', 'puzzle'), ('lki', 'puzzle')" \
  -c "UPDATE game_info SET family_id = 'fam.lk' WHERE game_id IN ('lka', 'lki')" \
  -c "CREATE FUNCTION verify_park_link() RETURNS trigger LANGUAGE plpgsql AS
        \$\$ BEGIN PERFORM pg_advisory_xact_lock(4242); RETURN NEW; END \$\$" \
  -c "CREATE TRIGGER verify_park BEFORE INSERT ON evaluation_log FOR EACH ROW
        WHEN (NEW.kind = 'pair_link') EXECUTE FUNCTION verify_park_link()"
hold "SELECT pg_advisory_xact_lock(4242)"
holder=$!
wait_for "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = 'verify_holder' AND l.locktype = 'advisory' AND l.granted"
PGAPPNAME=verify_mig "${P[@]}" -d verify -f migrations/054_eval_pairs.sql >"$TMP/mig.out" 2>&1 &
mig=$!
wait_for "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = 'verify_mig' AND l.locktype = 'advisory' AND NOT l.granted"
gi_locks=$("${P[@]}" -d verify -At -c "SELECT string_agg(l.mode, ',') FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = 'verify_mig' AND l.relation = 'game_info'::regclass AND l.granted
            AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')")
ss_update=ok
PGOPTIONS="$PGOPTIONS -c lock_timeout=2s" "${P[@]}" -d verify \
  -c "UPDATE game_info SET title = 'Signal Sense edit' WHERE game_id = 'lka'" >/dev/null 2>&1 || ss_update=failed
"${P[@]}" -d verify -c "INSERT INTO verify_go VALUES (1)"
wait "$holder"
mig_status=0; wait "$mig" || mig_status=$?
"${P[@]}" -d verify -c "DELETE FROM verify_go" -c "DROP TRIGGER verify_park ON evaluation_log" -c "DROP FUNCTION verify_park_link()"
[ "$mig_status" = 0 ] || { echo "054 failed while parked: $(cat "$TMP/mig.out")"; exit 1; }
[ -z "$gi_locks" ] || { echo "the safe-pair pass holds locks on game_info: $gi_locks"; exit 1; }
[ "$ss_update" = ok ] || { echo "a Signal Sense UPDATE of game_info waited on the safe-pair pass"; exit 1; }
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT count(*) FROM game_evaluations WHERE game_id IN ('lka', 'lki') AND pair_eval_id IS NOT NULL) = 2,
    'the parked pass linked its pair';
END \$\$;"

# trigger_lock_timeout: the game_info trigger is (re)created under a lock_timeout, so 054
# gives up instead of queueing behind an open Signal Sense transaction (which would stall
# every later game_info query behind its AccessExclusive request).
hold "LOCK TABLE game_info IN ACCESS SHARE MODE"
holder=$!
wait_for "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.application_name = 'verify_holder' AND l.relation = 'game_info'::regclass AND l.granted"
mig_status=0
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql >"$TMP/mig.out" 2>&1 || mig_status=$?
"${P[@]}" -d verify -c "INSERT INTO verify_go VALUES (1)"
wait "$holder"
"${P[@]}" -d verify -c "DROP TABLE verify_go"
[ "$mig_status" != 0 ] && grep -q 'lock timeout' "$TMP/mig.out" || {
  echo "054 did not give up on a locked game_info: status $mig_status, $(tail -3 "$TMP/mig.out")"; exit 1; }
"${P[@]}" -d verify -c "DO \$\$ BEGIN
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_game_info_eval_pair_unlink') = 1, 'trigger kept';
END \$\$;"

# rollback_block: the SQL in the "-- ROLLBACK:" block of 054 (each line behind "-- ", up to
# "-- END ROLLBACK") removes everything 054 added, and game_evaluations still takes an
# ordinary UPDATE (trg_game_evaluations_updated is back on the shared function). Then 054
# applies again on the rolled-back DB.
sed -n '/^-- ROLLBACK:/,/^-- END ROLLBACK/{/^-- ROLLBACK:/d;/^-- END ROLLBACK/d;s/^-- \{0,1\}//;p;}' \
  migrations/054_eval_pairs.sql >"$TMP/rollback.sql"
grep -q 'DROP COLUMN IF EXISTS pair_back' "$TMP/rollback.sql" || { echo "no ROLLBACK block found in 054"; exit 1; }
"${P[@]}" -d verify -f "$TMP/rollback.sql"
after_rollback=$(catalog)
[ "$after_rollback" = "$catalog_before_054" ] || {
  echo "ROLLBACK left the schema different from before 054:"; diff <(echo "$catalog_before_054") <(echo "$after_rollback"); exit 1; }
"${P[@]}" -d verify -c "DO \$\$
DECLARE i int;
BEGIN
  SELECT min(id) INTO i FROM game_evaluations;
  UPDATE game_evaluations SET initial_note = 'after rollback 1', updated_at = '2026-01-01Z' WHERE id = i;
  ASSERT (SELECT initial_note = 'after rollback 1' AND updated_at = now() FROM game_evaluations WHERE id = i),
    'an ordinary UPDATE works and stamps updated_at after the rollback';
END \$\$;"
"${P[@]}" -d verify -f migrations/054_eval_pairs.sql >/dev/null
[ "$(catalog)" = "$catalog_with_054" ] || {
  echo "054 re-applied after the ROLLBACK differs:"; diff <(echo "$catalog_with_054") <(catalog); exit 1; }

# ===== 055 (phase 2): credit column, merge snapshots, sticky front row, eval_stats_rows =====
# Applied after every 054 check (whose front_moves case pins 054's own front-row rule), on a DB
# full of linked, unlinked and rejected pairs. 055 itself changes no row and links nothing.
snap55() { "${P[@]}" -d verify -At -c "SELECT md5(string_agg((to_jsonb(g) - 'credit')::text, ',' ORDER BY id)) FROM game_evaluations g" \
                                    -c "SELECT count(*) FROM evaluation_log"; }
before=$(snap55)
"${P[@]}" -d verify -f migrations/055_eval_pairs_phase2.sql
"${P[@]}" -d verify -f migrations/055_eval_pairs_phase2.sql
[ "$(snap55)" = "$before" ] || { echo "applying 055 changed game_evaluations or evaluation_log"; exit 1; }
catalog_with_055=$(catalog)
"${P[@]}" -d verify -f scripts/sql-verify/phase2-schema.sql

# rollback_block_055: the "-- ROLLBACK:" block of 055 leaves the schema exactly as 054 left it
# (eval_pair_refresh_back's body back to 054's, byte for byte), then 055 applies again.
sed -n '/^-- ROLLBACK:/,/^-- END ROLLBACK/{/^-- ROLLBACK:/d;/^-- END ROLLBACK/d;s/^-- \{0,1\}//;p;}' \
  migrations/055_eval_pairs_phase2.sql >"$TMP/rollback55.sql"
grep -q 'DROP COLUMN IF EXISTS credit' "$TMP/rollback55.sql" || { echo "no ROLLBACK block found in 055"; exit 1; }
"${P[@]}" -d verify -f "$TMP/rollback55.sql"
[ "$(catalog)" = "$catalog_with_054" ] || {
  echo "055 ROLLBACK left the schema different from 054's:"; diff <(echo "$catalog_with_054") <(catalog); exit 1; }
"${P[@]}" -d verify -f migrations/055_eval_pairs_phase2.sql
[ "$(catalog)" = "$catalog_with_055" ] || {
  echo "055 re-applied after its ROLLBACK differs:"; diff <(echo "$catalog_with_055") <(catalog); exit 1; }

echo "eval pairs SQL checks: OK"
