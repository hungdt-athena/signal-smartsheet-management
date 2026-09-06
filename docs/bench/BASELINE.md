# Baseline — trước Tier 0 (2026-09-06)

Server-side Execution Time (EXPLAIN ANALYZE, median của 5 lần, đã warm-up):

| query                | median_ms | min_ms | max_ms |
|----------------------|-----------|--------|--------|
| A report_window      |    42.611 | 42.237 | 43.065 |
| B report_facets      |   188.202 |183.950 |190.505 |
| C eval_months        |    60.930 | 56.137 | 62.579 |
| D eval_list          |    75.614 | 73.049 |185.479 |
| E eval_evaluators    |    65.351 | 63.486 | 69.648 |
| F auth_session       |     0.073 |  0.071 |  0.075 |

Wall-clock round-trip (từ máy local ở VN → Neon us-east-2):
- SELECT 1: ~270 ms
- auth session query: ~264 ms (trong đó DB work chỉ 0.073 ms)

CẢNH BÁO khi so sánh: 270ms RTT là latency của máy local, KHÔNG đại diện cho Cloud Run.
Trên Cloud Run con số này thấp hơn nhiều. Dùng cột server-side Execution Time để so
sánh trước/sau; RTT chỉ để hiểu vì sao 0.1 và 0.4 đáng làm.
