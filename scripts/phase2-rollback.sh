#!/usr/bin/env bash
# Rolls back one phase 2 run (migration 055): eval_pair_phase2_rollback(RUN_ID, MAX_FAMILIES).
#   DATABASE_URL=postgres://... scripts/phase2-rollback.sh [--dry-run] RUN_ID [MAX_FAMILIES]
# Unlinks the run's pairs, clears their credit, deletes the run's pair_merge / pair_link log
# rows and its snapshots, and puts back each column the run wrote unless it was edited since.
# Works in batches of MAX_FAMILIES families (default 500), one transaction (one commit) per
# batch, and calls again until a batch returns nothing. A failed batch changes nothing; the
# batches before it stay committed, and running the script again goes on from there.
# Per batch it prints one row per evaluation row:
#   kept_columns  the columns that did NOT go back to their value before the run (edited since
#                 the run); NULL: the row no longer exists
#   linked_to     the row it is still linked to: linked to another row since the run, so that
#                 pair may differ in its shared columns until someone saves it
# --dry-run: the FIRST batch only, then ROLLBACK: shows what that batch would restore and keep,
#            changes nothing.
# A run already rolled back (or an unknown run id) finds nothing and changes nothing.
# PSQL overrides the psql binary (default: Homebrew postgresql@16).
set -euo pipefail
DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
RUN_ID=${1:-}
MAX=${2:-500}
if [ -z "$RUN_ID" ]; then
  echo "usage: DATABASE_URL=... $0 [--dry-run] RUN_ID [MAX_FAMILIES]" >&2
  exit 2
fi
if ! [[ "$MAX" =~ ^[1-9][0-9]*$ ]]; then
  echo "MAX_FAMILIES must be a positive integer, got: $MAX" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 2
fi
PSQL=${PSQL:-/usr/local/opt/postgresql@16/bin/psql}
END_TX=COMMIT
[ "$DRY" = 1 ] && END_TX=ROLLBACK

batch=0 rows=0 kept=0 linked=0
while :; do
  batch=$((batch + 1))
  out=$("$PSQL" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v run_id="$RUN_ID" -v max="$MAX" \
          -v end_tx="$END_TX" -v batch="$batch" <<'SQL'
BEGIN;
CREATE TEMP TABLE phase2_rollback_result ON COMMIT DROP AS
  SELECT * FROM eval_pair_phase2_rollback(:'run_id', :max);
SELECT count(*) AS n,
       count(*) FILTER (WHERE kept_columns IS NULL OR cardinality(kept_columns) > 0) AS k,
       count(linked_to) AS l,
       count(*) > 0 AS any
  FROM phase2_rollback_result \gset
\if :any
\echo batch :batch
SELECT r.game_evaluation_id, g.game_id, r.kept_columns, r.linked_to
  FROM phase2_rollback_result r LEFT JOIN game_evaluations g ON g.id = r.game_evaluation_id
 ORDER BY (r.linked_to IS NOT NULL) DESC, cardinality(r.kept_columns) DESC NULLS FIRST, r.game_evaluation_id;
\endif
:end_tx;
\echo phase2_rollback_counts :n :k :l
SQL
  )
  counts=$(printf '%s\n' "$out" | sed -n 's/^phase2_rollback_counts //p')
  printf '%s\n' "$out" | sed '/^phase2_rollback_counts /d'
  read -r n k l <<<"$counts"
  [ -n "${n:-}" ] || { echo "no result from batch $batch" >&2; exit 1; }
  rows=$((rows + n)) kept=$((kept + k)) linked=$((linked + l))
  [ "$n" = 0 ] && break
  [ "$DRY" = 1 ] && break
done
if [ "$DRY" = 1 ]; then
  echo "DRY RUN, nothing changed: run $RUN_ID, first batch ($MAX families max): $rows rows would be rolled back, $kept with kept columns, $linked still linked to another row"
else
  echo "run $RUN_ID: $rows rows rolled back in $((batch - 1)) batches, $kept with kept columns, $linked still linked to another row"
fi
