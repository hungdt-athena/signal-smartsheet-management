SET TIME ZONE 'UTC';
INSERT INTO game_info VALUES ('g1'),('g2'),('g3'),('g4'),('g5'),('g6'),('g7'),('g8'),('g9'),('g10'),('g11'),('g12'),('g13');
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, evaluate_date, updated_by) VALUES
 (1,'g1','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (2,'g2','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (3,'g3','alice','Bypass','2026-10-01 10:00+07','HungDT'),
 (4,'g4','Bob','Bypass','2026-09-20 10:00+07','Bob'),
 (5,'g5','Bob','Bypass','2026-09-28 00:30+07','Bob'),
 (6,'g6','Alice','Bypass','2026-10-01 10:00+07','Alice'),
 (7,'g7','Alice','List_Idea','2026-10-02 10:00+07','Alice'),
 (8,'g8','Alice',NULL,NULL,NULL),
 (9,'g9','Alice','Stale_release',NULL,NULL);
INSERT INTO playtest_tags (game_id, field_value, tagged_by, tagged_at) VALUES
 ('g1','t','ALICE@X','2026-10-01 09:00+07'),   -- case-insensitive email join
 ('g2','t','ALICE@x','2026-10-01 09:50+07'),
 ('g6','t','bob@x','2026-10-01 08:00+07'),
 ('g7','t','alice@x','2026-10-02 08:00+07'),
 ('g7','u','alice@x','2026-10-02 09:55+07');
-- Record seed: confirmed games with a recorder in their effective bucket.
-- g7: verdict seed AND record seed (Priority IV -> 20min, MyTL).
UPDATE game_evaluations SET final_conclusion = 'Priority IV', record_20min_assignee = 'MyTL',
  record_confirmed_at = '2026-10-03 10:00+07', batch = 'W1 Oct, 2026' WHERE id = 7;
INSERT INTO game_evaluations (id, game_id, initial_evaluator, initial_conclusion, final_conclusion,
  record_bucket, record_5min_assignee, record_20min_assignee, record_confirmed_at) VALUES
 (10,'g10','Shortcut',NULL,'Priority IV','5min','Bob',NULL,'2026-10-04 10:00+07'),  -- manual bucket wins: 5min, Bob
 (11,'g11','Alice',NULL,'Insight',NULL,NULL,'Carol','2026-10-04 10:00+07'),         -- recorder not in the effective bucket
 (12,'g12','Alice',NULL,'Insight',NULL,'Dave',NULL,NULL),                            -- draft: not confirmed
 (13,'g13','Alice',NULL,NULL,NULL,'Dave',NULL,'2026-10-04 10:00+07');               -- no bucket
