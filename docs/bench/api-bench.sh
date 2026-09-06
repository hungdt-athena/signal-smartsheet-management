#!/bin/bash
# End-to-end timing of the endpoints the Evaluations page actually calls.
# Median of N runs after one discarded warm-up. Needs a session cookie in /tmp/tok.txt.
PORT=${PORT:-3334}
N=${N:-5}
TOK=$(cat /tmp/tok.txt)
hit() { curl -s -b "next-auth.session-token=$TOK" -o /tmp/resp.json -w '%{time_total}' "http://localhost:$PORT$1"; }
row() {
  local label="$1" path="$2"
  hit "$path" > /dev/null                     # warm-up, discarded
  local t=()
  for i in $(seq 1 $N); do t+=("$(hit "$path")"); done
  local sorted=$(printf '%s\n' "${t[@]}" | sort -n)
  local med=$(printf '%s\n' "$sorted" | awk -v n=$N 'NR==int((n+1)/2)')
  local sz=$(wc -c < /tmp/resp.json | tr -d ' ')
  printf "%-46s %9.0f ms  %8s B\n" "$label" "$(echo "$med*1000" | bc)" "$sz"
}
echo "=== Evaluations page — end-to-end (port $PORT, median of $N) ==="
row "Evaluate tab, mở lần đầu (month=auto)"        "/api/evaluations?category=puzzle&limit=500&sort=desc&month=auto"
row "Evaluate tab, đổi filter conclusion"          "/api/evaluations?category=puzzle&limit=500&sort=desc&month=auto&conclusions=Bypass"
row "Short List, mở lần đầu (date_basis=evaluated)" "/api/evaluations?category=puzzle&limit=500&sort=desc&date_basis=evaluated"
row "Short List, đổi filter final_conclusion"      "/api/evaluations?category=puzzle&limit=500&sort=desc&date_basis=evaluated&final_conclusions=Insight"
row "Short List, đổi batch"                        "/api/evaluations?category=puzzle&limit=500&sort=desc&date_basis=evaluated&batch=W1"
