#!/bin/bash
PORT=${PORT:-3334}; N=${N:-3}; TOK=$(cat /tmp/tok.txt)
hit(){ curl -s -b "next-auth.session-token=$TOK" -o /tmp/resp.json -w '%{time_total}' "http://localhost:$PORT$1"; }
row(){ local l="$1" p="$2"; hit "$p">/dev/null; local t=(); for i in $(seq 1 $N); do t+=("$(hit "$p")"); done
  local med=$(printf '%s\n' "${t[@]}"|sort -n|awk -v n=$N 'NR==int((n+1)/2)')
  printf "%-46s %9.0f ms  %8s B\n" "$l" "$(echo "$med*1000"|bc)" "$(wc -c </tmp/resp.json|tr -d ' ')"; }
S="category=puzzle&limit=500&sort=desc"
echo "=== SAU KHI TÁCH FACET (median of $N) ==="
echo "-- rows (mỗi lần đổi filter đều gọi) --"
row "Evaluate: đổi filter conclusion"      "/api/evaluations?$S&month=auto&conclusions=Bypass&meta=0"
row "Short List: mở lần đầu"               "/api/evaluations?$S&date_basis=evaluated&meta=0"
row "Short List: đổi final_conclusion"     "/api/evaluations?$S&date_basis=evaluated&final_conclusions=Insight&meta=0"
row "Short List: đổi batch"                "/api/evaluations?$S&date_basis=evaluated&batch=W1&meta=0"
echo "-- facets (chỉ gọi khi category/evaluator/conclusion/ngày đổi) --"
row "facets"                               "/api/evaluations/facets?category=puzzle&date_basis=evaluated"
