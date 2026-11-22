#!/usr/bin/env bash
# Rolls back one phase 2 run (migration 055): eval_pair_phase2_rollback(RUN_ID).
#   DATABASE_URL=postgres://... scripts/phase2-rollback.sh RUN_ID
# Unlinks the run's pairs, clears their credit, deletes the run's pair_merge / pair_link log
# rows and its snapshots, and puts back each column the run wrote unless it was edited since.
# Prints one row per evaluation row of the run: kept_columns lists the columns that did NOT go
# back to their value before the run (edited after the run; NULL: the row no longer exists).
# One transaction: an error changes nothing. A second call for the same run does nothing.
set -euo pipefail
RUN_ID=${1:-}
if [ -z "$RUN_ID" ]; then
  echo "usage: DATABASE_URL=... $0 RUN_ID" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 2
fi
PSQL=/usr/local/opt/postgresql@16/bin/psql
"$PSQL" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v run_id="$RUN_ID" <<'SQL'
BEGIN;
CREATE TEMP TABLE phase2_rollback_result ON COMMIT DROP AS
  SELECT * FROM eval_pair_phase2_rollback(:'run_id');
\pset footer on
SELECT r.game_evaluation_id, g.game_id, r.kept_columns
  FROM phase2_rollback_result r LEFT JOIN game_evaluations g ON g.id = r.game_evaluation_id
 ORDER BY cardinality(r.kept_columns) DESC NULLS FIRST, r.game_evaluation_id;
SELECT :'run_id' AS run_id, count(*) AS rows_rolled_back,
       count(*) FILTER (WHERE r.kept_columns IS NULL OR cardinality(r.kept_columns) > 0) AS rows_with_kept_columns
  FROM phase2_rollback_result r;
COMMIT;
SQL
