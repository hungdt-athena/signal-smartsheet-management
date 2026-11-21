-- Migration 054: a game's Android and iOS rows are one game in Playtest
-- Spec: docs/superpowers/specs/2026-11-21-unified-game-playtest-design.md (6.1, 6.2)
--
-- One game with both stores is 2 game_info rows (same family_id, set by Signal Sense)
-- and 2 game_evaluations rows, so Playtest judged it twice. The 2 rows stay (Signal
-- Sense reads by game_id); this links them:
--   pair_eval_id   the other store's row, both ways (A -> B and B -> A)
--   pair_back      this row is the pair's back row; lists and counts skip it. A linked
--                  pair has exactly one back row. The front row is the one without a
--                  store-only result (Link_dead / Stale_release); if both or neither
--                  carry one, the lower id.
--   evaluation_log.pair_scope   'pair' | 'store'; NULL on older rows reads as 'store'.
--
-- The shared columns are listed once, in eval_pair_eval_cols() (respects the
-- Link_dead / Stale_release exception) and eval_pair_media_cols() (always shared while
-- linked: the video belongs to the pair, and n8n / YouTube reconcile can land on the
-- dead store's row). Every copy reads those two lists.
--
-- This file, part 1:
--   - link on insert (trg_eval_pair_link_insert): a new row whose game has a twin store
--     with exactly one row, not linked yet, links to it and fills its EMPTY columns from
--     it (a value the INSERT wrote itself, e.g. add-to-record's batch, is kept):
--       twin carries Link_dead / Stale_release -> media only; the new row is the front row
--       twin judged                            -> every shared column; new row is back
--       twin not judged                        -> holder, assign dates, batch + media
--     and the new row moves to the twin's category_group (same genre in the lists).
--     One evaluation_log row: kind 'pair_link', actor 'System', pair_scope 'store'.
--   - link the safe pairs already there (link_safe_eval_pairs(), run at the end): both
--     rows unjudged, same category_group, and every shared column equal or empty on one
--     side (batch, holder and media included). Everything else waits for phase 2.
-- Part 2 (copy on update, delete) and part 3 (unlink from game_info, ROLLBACK) follow.
--
-- Internal UPDATEs from the insert trigger run at pg_trigger_depth() > 1, so the copy
-- trigger of part 2 (depth 1 only) skips them.
--
-- ORDER: additive. Apply BEFORE the build that reads pair_back. The build from before
-- keeps working: it ignores the new columns, and a back row it lists is a full copy.
-- Idempotent: columns/indexes IF NOT EXISTS, functions replaced, trigger dropped and
-- recreated, the FK added only when missing, the safe-pair pass skips linked rows.
--
-- ROLLBACK: (added with part 3)

-- Two transactions, as 051: the first only adds columns (metadata only, the lock is
-- held for milliseconds), the second installs the functions and links.
BEGIN;

ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS pair_eval_id integer,
  ADD COLUMN IF NOT EXISTS pair_back    boolean NOT NULL DEFAULT false;

ALTER TABLE evaluation_log ADD COLUMN IF NOT EXISTS pair_scope text;

-- Not inline on ADD COLUMN: a re-run must not add a second FK.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'game_evaluations'::regclass
                   AND conname = 'game_evaluations_pair_eval_id_fkey') THEN
    ALTER TABLE game_evaluations ADD CONSTRAINT game_evaluations_pair_eval_id_fkey
      FOREIGN KEY (pair_eval_id) REFERENCES game_evaluations(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;

BEGIN;

-- A row is linked to at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_evaluations_pair_eval_id
  ON game_evaluations (pair_eval_id) WHERE pair_eval_id IS NOT NULL;

-- A result that belongs to one store only.
CREATE OR REPLACE FUNCTION eval_store_specific(c text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(c IN ('Link_dead', 'Stale_release'), false)
$$;

-- Shared, but a store-only result on either row stops the copy.
CREATE OR REPLACE FUNCTION eval_pair_eval_cols() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'initial_evaluator', 'assigned_date', 'first_assigned_date', 'initial_conclusion',
    'initial_note', 'initial_gameplay', 'initial_game_over', 'initial_level_complete',
    'initial_self_note', 'evaluate_date', 'final_evaluator', 'final_conclusion', 'final_note',
    'final_conclusion_date', 'batch', 'game_alike', 'updated_by', 'category_group'
  ]::text[]
$$;

-- Shared whenever the pair is linked, even with one store Link_dead.
CREATE OR REPLACE FUNCTION eval_pair_media_cols() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'drive_link', 'drive_date', 'record_bucket', 'record_assignee', 'record_assign_date',
    'record_confirmed_at',
    'record_5min_assignee', 'record_5min_date', 'record_5min_drive', 'record_5min_drive_date',
    'record_5min_confirmed_at', 'record_5min_batch',
    'record_20min_assignee', 'record_20min_date', 'record_20min_drive', 'record_20min_drive_date',
    'record_20min_confirmed_at', 'record_20min_batch',
    'youtube_link', 'youtube_uploaded_at', 'youtube_5min_link', 'youtube_5min_uploaded_at',
    'youtube_20min_link', 'youtube_20min_uploaded_at'
  ]::text[]
$$;

-- Two rows that may be linked: their games share a family_id, differ in os, neither is
-- family_unlinked, and each game has exactly one evaluation row.
CREATE OR REPLACE FUNCTION eval_pair_valid(a integer, b integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(a <> b AND EXISTS (
    SELECT 1
    FROM game_evaluations ea JOIN game_info ga ON ga.game_id = ea.game_id,
         game_evaluations eb JOIN game_info gb ON gb.game_id = eb.game_id
    WHERE ea.id = a AND eb.id = b
      AND ga.family_id IS NOT NULL AND ga.family_id = gb.family_id
      AND ga.os <> gb.os
      AND NOT COALESCE(ga.family_unlinked, false) AND NOT COALESCE(gb.family_unlinked, false)
      AND NOT EXISTS (SELECT 1 FROM game_evaluations x WHERE x.game_id = ea.game_id AND x.id <> ea.id)
      AND NOT EXISTS (SELECT 1 FROM game_evaluations x WHERE x.game_id = eb.game_id AND x.id <> eb.id)
  ), false)
$$;

-- Sets pair_back on a linked pair: the front row is the one without a store-only
-- result; both or neither -> the lower id. No-op unless a and b point at each other.
CREATE OR REPLACE FUNCTION eval_pair_refresh_back(a integer, b integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ca text; cb text; front integer;
BEGIN
  SELECT initial_conclusion INTO ca FROM game_evaluations WHERE id = a AND pair_eval_id = b;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT initial_conclusion INTO cb FROM game_evaluations WHERE id = b AND pair_eval_id = a;
  IF NOT FOUND THEN RETURN; END IF;
  front := CASE WHEN eval_store_specific(ca) = eval_store_specific(cb) THEN LEAST(a, b)
                WHEN eval_store_specific(ca) THEN b
                ELSE a END;
  UPDATE game_evaluations SET pair_back = (id <> front)
   WHERE id IN (a, b) AND pair_back IS DISTINCT FROM (id <> front);
END;
$$;

-- Fills the EMPTY columns (NULL, '' or '[]') of row target from row source, for the
-- columns named. A value target already has is kept.
-- 051's record_slots trigger re-freezes record_<b>_batch when the fill moves target's own
-- bucket (it takes 'Priority IV' or a record_bucket); those two columns are then put
-- back to what the fill meant, in a second UPDATE that leaves the own bucket alone.
CREATE OR REPLACE FUNCTION eval_pair_fill(target integer, source integer, cols text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE rg game_evaluations; rs game_evaluations; sets text; b5 text; b20 text;
BEGIN
  IF target IS NULL OR source IS NULL OR COALESCE(cardinality(cols), 0) = 0 THEN RETURN; END IF;
  SELECT * INTO rg FROM game_evaluations WHERE id = target;
  SELECT * INTO rs FROM game_evaluations WHERE id = source;
  SELECT string_agg(format(
           '%1$I = CASE WHEN COALESCE(g.%1$I::text, '''') IN ('''', ''[]'') '
           'AND COALESCE(s.%1$I::text, '''') NOT IN ('''', ''[]'') THEN s.%1$I ELSE g.%1$I END', c), ', ')
    INTO sets FROM unnest(cols) c;
  EXECUTE format('UPDATE game_evaluations g SET %s FROM game_evaluations s WHERE g.id = $1 AND s.id = $2', sets)
    USING target, source;

  b5  := CASE WHEN 'record_5min_batch' = ANY (cols) AND COALESCE(rg.record_5min_batch, '') = ''
                   AND COALESCE(rs.record_5min_batch, '') <> '' THEN rs.record_5min_batch
              ELSE rg.record_5min_batch END;
  b20 := CASE WHEN 'record_20min_batch' = ANY (cols) AND COALESCE(rg.record_20min_batch, '') = ''
                   AND COALESCE(rs.record_20min_batch, '') <> '' THEN rs.record_20min_batch
              ELSE rg.record_20min_batch END;
  IF 'record_5min_batch' = ANY (cols) OR 'record_20min_batch' = ANY (cols) THEN
    UPDATE game_evaluations SET record_5min_batch = b5, record_20min_batch = b20
     WHERE id = target
       AND (record_5min_batch IS DISTINCT FROM b5 OR record_20min_batch IS DISTINCT FROM b20);
  END IF;
END;
$$;

-- Links row a (the one joining) to row b (the one already there), both ways, and fills
-- a's empty columns from b (spec 6.2 b). Returns false, changing nothing, when the pair
-- is not valid, either row is already linked, or a carries a verdict of its own that b
-- does not share (two verdicts are phase 2; pass the judged row as b).
-- Used by the insert trigger, link_safe_eval_pairs() and phase 2.
CREATE OR REPLACE FUNCTION link_eval_pair(a integer, b integer) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE ra game_evaluations; rb game_evaluations; done game_evaluations;
        store_only boolean; cols text[];
BEGIN
  IF a IS NULL OR b IS NULL OR a = b THEN RETURN false; END IF;
  -- both rows, in id order, so two linkers cannot deadlock
  PERFORM 1 FROM game_evaluations WHERE id IN (a, b) ORDER BY id FOR UPDATE;
  SELECT * INTO ra FROM game_evaluations WHERE id = a;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO rb FROM game_evaluations WHERE id = b;
  IF NOT FOUND THEN RETURN false; END IF;
  IF ra.pair_eval_id IS NOT NULL OR rb.pair_eval_id IS NOT NULL THEN RETURN false; END IF;
  IF NOT eval_pair_valid(a, b) THEN RETURN false; END IF;
  IF ra.initial_conclusion IS NOT NULL AND NOT eval_store_specific(ra.initial_conclusion)
     AND NOT eval_store_specific(rb.initial_conclusion)
     AND ra.initial_conclusion IS DISTINCT FROM rb.initial_conclusion THEN
    RETURN false;
  END IF;

  store_only := eval_store_specific(ra.initial_conclusion) OR eval_store_specific(rb.initial_conclusion);
  cols := eval_pair_media_cols();
  IF NOT store_only THEN
    cols := cols || CASE WHEN rb.initial_conclusion IS NOT NULL
                         THEN array_remove(eval_pair_eval_cols(), 'category_group')
                         ELSE ARRAY['initial_evaluator', 'assigned_date', 'first_assigned_date', 'batch'] END;
  END IF;
  -- fill before linking: nothing is linked yet, so no copy trigger reacts to the fill
  PERFORM eval_pair_fill(a, b, cols);
  IF NOT store_only AND ra.category_group IS DISTINCT FROM rb.category_group THEN
    -- a has no other row (eval_pair_valid), so (game_id, category_group) stays unique
    UPDATE game_evaluations SET category_group = rb.category_group WHERE id = a;
  END IF;

  UPDATE game_evaluations SET pair_eval_id = CASE id WHEN a THEN b ELSE a END WHERE id IN (a, b);
  PERFORM eval_pair_refresh_back(a, b);

  SELECT * INTO done FROM game_evaluations WHERE id = a;
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, source, kind,
    conclusion_before, conclusion_after, final_before, final_after, batch_before, batch_after,
    changed, pair_scope)
  VALUES (a, ra.game_id, 'System', ra.initial_evaluator, 'other', 'pair_link',
    ra.initial_conclusion, done.initial_conclusion, ra.final_conclusion, done.final_conclusion,
    ra.batch, done.batch,
    ra.initial_conclusion IS DISTINCT FROM done.initial_conclusion, 'store');
  RETURN true;
END;
$$;

-- Link on insert (spec 6.2 b).
CREATE OR REPLACE FUNCTION eval_pair_link_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE fam text; my_os text; twin integer; n_twin bigint;
BEGIN
  SELECT gi.family_id, gi.os INTO fam, my_os
    FROM game_info gi
   WHERE gi.game_id = NEW.game_id AND NOT COALESCE(gi.family_unlinked, false);
  IF fam IS NULL OR my_os IS NULL THEN RETURN NULL; END IF;
  -- One linker per family until commit: 2 stores pushed in one statement, or by two
  -- sessions, see each other and link once.
  PERFORM pg_advisory_xact_lock(hashtext(fam));
  -- the other row of the same statement may have linked this one already
  IF EXISTS (SELECT 1 FROM game_evaluations WHERE id = NEW.id AND pair_eval_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT min(t.id), count(*) INTO twin, n_twin
    FROM game_info g JOIN game_evaluations t ON t.game_id = g.game_id
   WHERE g.family_id = fam AND g.os <> my_os AND NOT COALESCE(g.family_unlinked, false);
  IF n_twin = 1 THEN
    PERFORM link_eval_pair(NEW.id, twin);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_pair_link_insert ON game_evaluations;
CREATE TRIGGER trg_eval_pair_link_insert
  AFTER INSERT ON game_evaluations
  FOR EACH ROW EXECUTE FUNCTION eval_pair_link_on_insert();

-- Pairs already there that can be linked with no judgment call (spec 6.2 d): f is the
-- lower id (the front row, as neither is judged). True when the 2 games are the whole
-- family, the pair is valid, neither is linked or judged, they share category_group,
-- and every other shared column (batch, holder, notes, media ...) is equal or empty on
-- one side. The assign dates may differ: they are merged.
CREATE OR REPLACE FUNCTION eval_pair_safe(f integer, b integer) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE rf game_evaluations; rb game_evaluations; cols text[]; ok boolean;
BEGIN
  IF NOT eval_pair_valid(f, b) THEN RETURN false; END IF;
  SELECT * INTO rf FROM game_evaluations WHERE id = f;
  SELECT * INTO rb FROM game_evaluations WHERE id = b;
  IF rf.pair_eval_id IS NOT NULL OR rb.pair_eval_id IS NOT NULL
     OR rf.initial_conclusion IS NOT NULL OR rb.initial_conclusion IS NOT NULL
     OR rf.category_group <> rb.category_group THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM game_info g
       WHERE g.family_id = (SELECT family_id FROM game_info WHERE game_id = rf.game_id)) <> 2 THEN
    RETURN false;
  END IF;
  SELECT array_agg(c) INTO cols FROM unnest(eval_pair_eval_cols() || eval_pair_media_cols()) c
   WHERE c NOT IN ('category_group', 'assigned_date', 'first_assigned_date', 'updated_by');
  EXECUTE format('SELECT %s FROM game_evaluations f, game_evaluations b WHERE f.id = $1 AND b.id = $2',
    (SELECT string_agg(format(
       '(COALESCE(f.%1$I::text, '''') IN ('''', ''[]'') OR COALESCE(b.%1$I::text, '''') IN ('''', ''[]'') '
       'OR f.%1$I = b.%1$I)', c), ' AND ') FROM unnest(cols) c))
    INTO ok USING f, b;
  RETURN ok;
END;
$$;

-- Links every safe pair; returns how many it linked. Each side takes what the other
-- has and it lacks; first_assigned_date is the earlier one, assigned_date the front
-- row's (the back row's when the front has none).
CREATE OR REPLACE FUNCTION link_safe_eval_pairs() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r record; linked integer := 0; cols text[];
BEGIN
  SELECT array_agg(c) INTO cols FROM unnest(eval_pair_eval_cols() || eval_pair_media_cols()) c
   WHERE c NOT IN ('category_group', 'assigned_date', 'first_assigned_date', 'updated_by');
  FOR r IN
    SELECT LEAST(ea.id, eb.id) AS f, GREATEST(ea.id, eb.id) AS b
    FROM game_info ga
    JOIN game_info gb ON gb.family_id = ga.family_id AND ga.os < gb.os
    JOIN game_evaluations ea ON ea.game_id = ga.game_id
    JOIN game_evaluations eb ON eb.game_id = gb.game_id
    WHERE ga.family_id IS NOT NULL
      AND NOT COALESCE(ga.family_unlinked, false) AND NOT COALESCE(gb.family_unlinked, false)
      AND ea.pair_eval_id IS NULL AND eb.pair_eval_id IS NULL
      AND ea.initial_conclusion IS NULL AND eb.initial_conclusion IS NULL
      AND ea.category_group = eb.category_group
    ORDER BY 1
  LOOP
    PERFORM 1 FROM game_evaluations WHERE id IN (r.f, r.b) ORDER BY id FOR UPDATE;
    CONTINUE WHEN NOT eval_pair_safe(r.f, r.b);
    PERFORM eval_pair_fill(r.f, r.b, cols);
    PERFORM eval_pair_fill(r.b, r.f, cols);
    UPDATE game_evaluations g SET
      first_assigned_date = LEAST(f.first_assigned_date, b.first_assigned_date),
      assigned_date       = COALESCE(f.assigned_date, b.assigned_date)
    FROM game_evaluations f, game_evaluations b
    WHERE g.id IN (r.f, r.b) AND f.id = r.f AND b.id = r.b
      AND (g.first_assigned_date IS DISTINCT FROM LEAST(f.first_assigned_date, b.first_assigned_date)
           OR g.assigned_date IS DISTINCT FROM COALESCE(f.assigned_date, b.assigned_date));
    IF link_eval_pair(r.b, r.f) THEN
      linked := linked + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '054: linked % safe store pairs', linked;
  RETURN linked;
END;
$$;

-- updated_at is left alone, as in 051: the panel shows it as "Updated ... by", and
-- nobody edited these rows.
ALTER TABLE game_evaluations DISABLE TRIGGER trg_game_evaluations_updated;
SELECT link_safe_eval_pairs() AS safe_pairs_linked;
ALTER TABLE game_evaluations ENABLE TRIGGER trg_game_evaluations_updated;

COMMIT;
