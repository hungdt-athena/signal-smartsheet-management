#!/bin/bash
# Runs each benchmark query N times via EXPLAIN ANALYZE, prints median Execution Time.
# One warm-up run is discarded so we compare warm-vs-warm.
set -e
cd "$(dirname "$0")"
export $(grep -E '^DATABASE_URL=' "$REPO/.env.local" | sed 's/"//g')
N=${N:-5}
printf "%-28s %10s %10s %10s\n" "query" "median_ms" "min_ms" "max_ms"
for f in q_*.sql; do
  q=$(cat "$f")
  psql "$DATABASE_URL" -tAqc "EXPLAIN (ANALYZE) $q" > /dev/null 2>&1 || true   # warm-up
  times=()
  for i in $(seq 1 $N); do
    t=$(psql "$DATABASE_URL" -tAqc "EXPLAIN (ANALYZE) $q" 2>/dev/null | grep -oE 'Execution Time: [0-9.]+' | grep -oE '[0-9.]+')
    times+=("$t")
  done
  sorted=$(printf '%s\n' "${times[@]}" | sort -n)
  med=$(printf '%s\n' "$sorted" | awk -v n=$N 'NR==int((n+1)/2)')
  mn=$(printf  '%s\n' "$sorted" | head -1)
  mx=$(printf  '%s\n' "$sorted" | tail -1)
  printf "%-28s %10s %10s %10s\n" "${f%.sql}" "$med" "$mn" "$mx"
done
