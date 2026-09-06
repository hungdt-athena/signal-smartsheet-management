-- D: Short List main list query (LATERAL trends + game_info + developer), Sep 2026 window
SELECT ge.id, ge.game_id, ge.initial_note, ge.final_note, ge.game_alike,
  gi.title, gi.os, gi.app_link, gi.icon_url,
  COALESCE(gi.initial_release, gi.temp_release)::text AS release_date,
  COALESCE(dev.developer_name, dev.dev_company) AS publisher_name,
  COALESCE(tg.tags,'[]'::json) AS tags
FROM game_evaluations ge
JOIN game_info gi ON ge.game_id = gi.game_id
LEFT JOIN developer dev ON gi.publisher_id = dev.id
LEFT JOIN LATERAL (
  SELECT json_agg(t) AS tags FROM (
    SELECT cfv.field_value, false AS pending FROM custom_field_values cfv
    WHERE cfv.game_id = ge.game_id AND cfv.field_name = 'Trends'
    UNION ALL
    SELECT pt.field_value, true FROM playtest_tags pt
    WHERE pt.game_id = ge.game_id AND pt.status='pending'
  ) t) tg ON true
WHERE ge.category_group='puzzle'
ORDER BY COALESCE(ge.evaluate_date, ge.updated_at) DESC, ge.imported_at DESC
LIMIT 500;
