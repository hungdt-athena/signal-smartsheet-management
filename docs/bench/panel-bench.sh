#!/bin/bash
# The five requests the Evaluate detail panel fires when a game is opened.
PORT=${PORT:-3334}; N=${N:-3}; TOK=$(cat /tmp/tok.txt)
GID=${GID:?set GID}
hit() { curl -s -b "next-auth.session-token=$TOK" -o /tmp/p.json -w '%{time_total}' "http://localhost:$PORT$1"; }
row() { local l="$1" p="$2"; hit "$p" >/dev/null; local t=(); for i in $(seq 1 $N); do t+=("$(hit "$p")"); done
  local med=$(printf '%s\n' "${t[@]}" | sort -n | awk -v n=$N 'NR==int((n+1)/2)')
  printf "%-42s %9.0f ms  %8s B\n" "$l" "$(echo "$med*1000"|bc)" "$(wc -c </tmp/p.json|tr -d ' ')"; }
echo "=== Mở panel đánh giá 1 game (median of $N) ==="
row "/api/evaluations/{gameId}"      "/api/evaluations/$GID"
row "/api/sheets/ytb-uploaded"       "/api/sheets/ytb-uploaded"
row "/api/trends/options"            "/api/trends/options"
row "/api/playtest-tags?gameId="     "/api/playtest-tags?gameId=$GID"
row "/api/team/recorders"            "/api/team/recorders"
