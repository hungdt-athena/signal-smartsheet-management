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
-- KEEP THEM IN STEP WITH THE TABLE: a later migration that adds, renames or drops a shared
-- column of game_evaluations must update eval_pair_eval_cols() / eval_pair_media_cols() in
-- the same migration. A renamed or dropped column still listed makes every link fail
-- (eval_pair_fill names it: a WARNING, the new row stays a lone game, the safe-pair pass
-- links nothing); a new shared column not listed is never copied, so the two rows of a pair
-- drift apart without any error.
--
-- This file:
--   - link on insert (trg_eval_pair_link_insert): a new row whose game has a twin store
--     with exactly one row, not linked yet, links to it and fills its EMPTY columns from
--     it (a value the INSERT wrote itself is kept, and an UPDATE that later writes the same
--     value changes nothing, so it is not copied to the twin: add-to-record therefore
--     inserts without the batch and sets it in its UPDATE):
--       twin carries Link_dead / Stale_release -> media only; the new row is the front row
--       twin judged                            -> every shared column; new row is back
--       twin not judged                        -> holder, assign dates, batch + media
--     and the new row moves to the twin's category_group (same genre in the lists).
--     One evaluation_log row: kind 'pair_link', actor 'System', pair_scope 'store',
--     owner / owner_after = the new row's holder before / after. An error while linking
--     is a WARNING, never a failed INSERT.
--   - copy on update (trg_eval_pair_sync): every write to a linked row reaches its twin,
--     column by column (only the columns the write changed, in one UPDATE of the twin),
--     with the Link_dead / Stale_release exception and the reopen rule (the reopened row
--     takes the pair's result; if it reopens with a verdict of its own while the twin is
--     not judged, that verdict becomes the pair's); pair_back is recomputed after each
--     write; a pair that is no longer valid is unlinked instead.
--   - delete (trg_eval_pair_delete): the twin of a deleted row is a lone game again.
--   - unlink from game_info (trg_game_info_eval_pair_unlink): Signal Sense sets
--     family_unlinked or changes family_id -> a pair no longer valid splits, data kept.
--     Its function is SECURITY DEFINER (search_path public, pg_temp), so it works under
--     Signal Sense's role and search_path.
--   - unlink_eval_pair(id): THE unlink, used by the copy trigger and the game_info
--     trigger. Both rows go back to lone games and each gets one evaluation_log row
--     (kind 'pair_unlink', actor 'System', pair_scope 'store'). To split a pair by hand,
--     call it: a manual UPDATE that sets pair_eval_id = NULL on one row leaves the twin
--     half-linked (still pointing, maybe still the back row and hidden from the lists).
--   - updated_at: trg_game_evaluations_updated now runs game_evaluations_touch_updated(),
--     which leaves updated_at alone when only pair_eval_id / pair_back change.
--   - link the safe pairs already there (link_safe_eval_pairs(), run at the end): both
--     rows unjudged, same category_group, and every shared column equal or empty on one
--     side (batch, holder and media included). Everything else waits for phase 2.
--
-- SIGNAL SENSE: trg_game_info_eval_pair_unlink is a trigger on game_info, the table the
-- Signal Sense repo (signal-deploy) owns. It runs inside Signal Sense's transactions, so
-- tell that repo it exists (runbook). It cannot fail their UPDATE: any error in it is a
-- WARNING. It fires only when family_id or family_unlinked actually change.
--
-- Trigger depth: the triggers' own writes run at pg_trigger_depth() > 1, and the copy
-- trigger skips those, so a copy never copies back. link_safe_eval_pairs() is called by a
-- top-level SELECT, so the copy trigger does fire (depth 1) on its writes: its fills run
-- before the rows are linked (the WHEN clause skips unlinked rows), the link itself changes
-- pair_eval_id (skipped by the WHEN clause) and pair_back alone (nothing to copy). Re-running
-- this file is checked to change nothing.
--
-- TIMING (runbook): on the local sample DB (18099 evaluation rows, 2026-11-21) the
-- safe-pair pass took 100-220 ms to link 3 pairs and ~55 ms to find nothing (re-run).
-- game_evaluations is locked (DISABLE TRIGGER) for that long; game_info is not locked
-- by it: its trigger is created in a third, short transaction with lock_timeout 5 s.
--
-- ORDER: additive. Apply BEFORE the build that reads pair_back. The build from before
-- keeps working: it ignores the new columns, and a back row it lists is a full copy.
-- Idempotent: columns/indexes IF NOT EXISTS, functions replaced, trigger dropped and
-- recreated, the FK added only when missing, the safe-pair pass skips linked rows.
--
-- ROLLBACK: run the lines below up to END ROLLBACK, without their leading "-- ", in psql
-- -- (scripts/verify-eval-pairs.sh extracts and runs them). trg_game_evaluations_updated
-- -- goes back to the shared update_game_evaluations_timestamp() FIRST: with the pair
-- -- columns gone, game_evaluations_touch_updated() would fail every UPDATE. The
-- -- evaluation_log rows 054 wrote (pair_link / pair_unlink) stay, without pair_scope.
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_game_evaluations_updated ON game_evaluations;
-- CREATE TRIGGER trg_game_evaluations_updated BEFORE UPDATE ON game_evaluations
--   FOR EACH ROW EXECUTE FUNCTION update_game_evaluations_timestamp();
-- DROP TRIGGER IF EXISTS trg_game_info_eval_pair_unlink ON game_info;
-- DROP TRIGGER IF EXISTS trg_eval_pair_link_insert ON game_evaluations;
-- DROP TRIGGER IF EXISTS trg_eval_pair_sync ON game_evaluations;
-- DROP TRIGGER IF EXISTS trg_eval_pair_delete ON game_evaluations;
-- DROP FUNCTION IF EXISTS game_info_eval_pair_unlink();
-- DROP FUNCTION IF EXISTS link_safe_eval_pairs();
-- DROP FUNCTION IF EXISTS eval_pair_safe(integer, integer);
-- DROP FUNCTION IF EXISTS eval_pair_on_delete();
-- DROP FUNCTION IF EXISTS eval_pair_sync();
-- DROP FUNCTION IF EXISTS unlink_eval_pair(integer);
-- DROP FUNCTION IF EXISTS eval_pair_copy(integer, game_evaluations, text[]);
-- DROP FUNCTION IF EXISTS game_evaluations_touch_updated();
-- DROP FUNCTION IF EXISTS eval_pair_link_on_insert();
-- DROP FUNCTION IF EXISTS link_eval_pair(integer, integer);
-- DROP FUNCTION IF EXISTS eval_pair_fill(integer, integer, text[]);
-- DROP FUNCTION IF EXISTS eval_pair_refresh_back(integer, integer);
-- DROP FUNCTION IF EXISTS eval_pair_valid(integer, integer);
-- DROP FUNCTION IF EXISTS eval_pair_media_cols();
-- DROP FUNCTION IF EXISTS eval_pair_eval_cols();
-- DROP FUNCTION IF EXISTS eval_store_specific(text);
-- DROP INDEX IF EXISTS uq_game_evaluations_pair_eval_id;
-- ALTER TABLE game_evaluations DROP CONSTRAINT IF EXISTS game_evaluations_pair_eval_id_fkey;
-- ALTER TABLE game_evaluations DROP COLUMN IF EXISTS pair_eval_id, DROP COLUMN IF EXISTS pair_back;
-- ALTER TABLE evaluation_log DROP COLUMN IF EXISTS pair_scope;
-- COMMIT;
-- END ROLLBACK

-- Three transactions: the first only adds columns (metadata only, the lock is held for
-- milliseconds), the second installs the functions and links, the third adds the trigger
-- on Signal Sense's game_info (see there).
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
  -- owner_after: the holder a ends up with, so History shows the holder change
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, owner_after, source, kind,
    conclusion_before, conclusion_after, final_before, final_after, batch_before, batch_after,
    changed, pair_scope)
  VALUES (a, ra.game_id, 'System', ra.initial_evaluator, done.initial_evaluator, 'other', 'pair_link',
    ra.initial_conclusion, done.initial_conclusion, ra.final_conclusion, done.final_conclusion,
    ra.batch, done.batch,
    ra.initial_conclusion IS DISTINCT FROM done.initial_conclusion, 'store');
  RETURN true;
END;
$$;

-- Link on insert (spec 6.2 b). Linking is a convenience on top of the INSERT (push,
-- add-to-record, n8n): an error in it must never fail the INSERT. It is caught, logged as
-- a WARNING, and its half-done work rolls back with the block, so the row stays a lone
-- game (the safe-pair pass or phase 2 can link it later).
CREATE OR REPLACE FUNCTION eval_pair_link_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE fam text; my_os text; twin integer; n_twin bigint;
BEGIN
  BEGIN
    SELECT gi.family_id, gi.os INTO fam, my_os
      FROM game_info gi
     WHERE gi.game_id = NEW.game_id AND NOT COALESCE(gi.family_unlinked, false);
    IF fam IS NULL OR my_os IS NULL THEN RETURN NULL; END IF;
    -- One linker per family until commit: 2 stores pushed in one statement, or by two
    -- sessions, see each other and link once. Two-key form, first key 54 (this migration):
    -- the single-key space is left to other code on this database (Signal Sense).
    PERFORM pg_advisory_xact_lock(54, hashtext(fam));
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
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '054: evaluation % (game %) was not linked to its store pair: % (%)',
      NEW.id, NEW.game_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_pair_link_insert ON game_evaluations;
CREATE TRIGGER trg_eval_pair_link_insert
  AFTER INSERT ON game_evaluations
  FOR EACH ROW EXECUTE FUNCTION eval_pair_link_on_insert();

-- updated_at is "last edited". Linking, unlinking and moving the front row only write
-- pair_eval_id / pair_back: not an edit, so updated_at stays. Its own function because
-- update_game_evaluations_timestamp() is shared with weekly_feedback, which has no pair
-- columns. Same trigger name, so the BEFORE UPDATE order (record_slots, then this) holds.
CREATE OR REPLACE FUNCTION game_evaluations_touch_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pair_eval_id IS DISTINCT FROM OLD.pair_eval_id OR NEW.pair_back IS DISTINCT FROM OLD.pair_back)
     AND to_jsonb(NEW) - ARRAY['pair_eval_id', 'pair_back', 'updated_at']
       = to_jsonb(OLD) - ARRAY['pair_eval_id', 'pair_back', 'updated_at'] THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_game_evaluations_updated ON game_evaluations;
CREATE TRIGGER trg_game_evaluations_updated
  BEFORE UPDATE ON game_evaluations
  FOR EACH ROW EXECUTE FUNCTION game_evaluations_touch_updated();

-- Writes src's value of each column in cols into row target, in one UPDATE, for the
-- columns where target differs (an equal column is not rewritten). When the copy can
-- move target's own Record bucket (record_bucket or final_conclusion), 051's
-- record_slots trigger re-freezes target's record_<b>_batch from target's old batch;
-- those two are then set to src's, because the media group is the pair's.
CREATE OR REPLACE FUNCTION eval_pair_copy(target integer, src game_evaluations, cols text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE js jsonb := to_jsonb(src); jt jsonb; diff text[];
BEGIN
  SELECT to_jsonb(g) INTO jt FROM game_evaluations g WHERE id = target;
  IF jt IS NULL THEN RETURN; END IF;
  SELECT array_agg(c) INTO diff FROM unnest(cols) c WHERE js -> c IS DISTINCT FROM jt -> c;
  IF diff IS NULL THEN RETURN; END IF;
  EXECUTE format('UPDATE game_evaluations SET %s WHERE id = $2',
                 (SELECT string_agg(format('%1$I = ($1).%1$I', c), ', ') FROM unnest(diff) c))
    USING src, target;
  IF diff && ARRAY['record_bucket', 'final_conclusion', 'record_5min_batch', 'record_20min_batch'] THEN
    UPDATE game_evaluations
       SET record_5min_batch = src.record_5min_batch, record_20min_batch = src.record_20min_batch
     WHERE id = target
       AND (record_5min_batch IS DISTINCT FROM src.record_5min_batch
            OR record_20min_batch IS DISTINCT FROM src.record_20min_batch);
  END IF;
END;
$$;

-- The one unlink (copy trigger on an invalid pair, game_info trigger, by hand): row a and
-- every row pointing at a go back to lone games (pair_eval_id NULL, pair_back false), their
-- data kept. A row that a points at but that points elsewhere belongs to another pair and is
-- left alone. Also heals a half-linked pair (one side cleared by hand). One evaluation_log
-- row per row it unlinks: kind 'pair_unlink', actor 'System', pair_scope 'store'. Returns
-- whether it unlinked anything. A delete does not come here (trg_eval_pair_delete, no log).
CREATE OR REPLACE FUNCTION unlink_eval_pair(a integer) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF a IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM game_evaluations WHERE id = a OR pair_eval_id = a ORDER BY id FOR UPDATE;
  WITH gone AS (
    UPDATE game_evaluations SET pair_eval_id = NULL, pair_back = false
     WHERE (id = a OR pair_eval_id = a) AND (pair_eval_id IS NOT NULL OR pair_back)
    RETURNING id, game_id, initial_evaluator, initial_conclusion, final_conclusion, batch
  )
  INSERT INTO evaluation_log (game_evaluation_id, game_id, actor, owner, owner_after, source, kind,
    conclusion_before, conclusion_after, final_before, final_after, batch_before, batch_after,
    changed, pair_scope)
  SELECT id, game_id, 'System', initial_evaluator, initial_evaluator, 'other', 'pair_unlink',
    initial_conclusion, initial_conclusion, final_conclusion, final_conclusion, batch, batch,
    false, 'store'
  FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

-- Copy on update (spec 6.2 a). R is the row just written, T its twin.
--   pair no longer valid (Unlink, family change, a second row) -> unlink_eval_pair (both
--                rows split, one pair_unlink log each), copy nothing
--   media group  -> always: the columns R just changed go to T
--   evaluation group, by the store-only result (Link_dead / Stale_release):
--     R just reopened (store-only -> not) -> R takes T's whole group, unless T is
--                                            store-only too (a pending T gives its holder
--                                            and assign dates, and clears what the dead
--                                            store had written). Exception: R reopens WITH
--                                            a verdict and T is not judged -> R's whole
--                                            group goes to T instead.
--     R and T both without one             -> the columns R just changed go to T, media
--                                            and evaluation in ONE UPDATE of T
--     otherwise (R just went dead, R or T store-only) -> nothing
--   then pair_back is recomputed.
-- Only the columns R changed (OLD vs NEW) are copied, so two people saving two columns
-- of one pair do not overwrite each other. Values are read from R as it is now, not from
-- NEW: one statement that writes both rows of a pair then still ends with them equal.
-- Root statement only: its own writes run at depth 2 and are skipped, so nothing loops.
-- The WHEN clause skips unlinked rows and the writes that link or unlink.
CREATE OR REPLACE FUNCTION eval_pair_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE t integer := NEW.pair_eval_id; rc game_evaluations; tr game_evaluations;
        jn jsonb := to_jsonb(NEW); jo jsonb := to_jsonb(OLD); media text[]; evals text[];
        reopen boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  SELECT array_agg(c) INTO media FROM unnest(eval_pair_media_cols()) c WHERE jn -> c IS DISTINCT FROM jo -> c;
  SELECT array_agg(c) INTO evals FROM unnest(eval_pair_eval_cols()) c WHERE jn -> c IS DISTINCT FROM jo -> c;
  -- a write of pair_back alone (eval_pair_refresh_back at depth 0) has nothing to copy
  IF media IS NULL AND evals IS NULL AND NEW.pair_back IS DISTINCT FROM OLD.pair_back THEN
    RETURN NULL;
  END IF;

  SELECT * INTO rc FROM game_evaluations WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO tr FROM game_evaluations WHERE id = t;
  IF NOT FOUND OR tr.pair_eval_id IS DISTINCT FROM NEW.id OR NOT eval_pair_valid(NEW.id, t) THEN
    PERFORM unlink_eval_pair(NEW.id);
    RETURN NULL;
  END IF;

  reopen := eval_store_specific(OLD.initial_conclusion) AND NOT eval_store_specific(rc.initial_conclusion);
  IF NOT reopen AND NOT eval_store_specific(rc.initial_conclusion) AND NOT eval_store_specific(tr.initial_conclusion) THEN
    -- the usual save: what R changed, media and evaluation alike, in one UPDATE of T
    IF media || evals IS NOT NULL THEN
      PERFORM eval_pair_copy(t, rc, media || evals);
    END IF;
  ELSE
    IF media IS NOT NULL THEN
      PERFORM eval_pair_copy(t, rc, media);
    END IF;
    IF reopen AND NOT eval_store_specific(tr.initial_conclusion) THEN
      IF rc.initial_conclusion IS NOT NULL AND tr.initial_conclusion IS NULL THEN
        -- reopened with a verdict of its own while the pair is not judged: R's is the pair's
        PERFORM eval_pair_copy(t, rc, eval_pair_eval_cols());
      ELSE
        SELECT * INTO tr FROM game_evaluations WHERE id = t;
        PERFORM eval_pair_copy(NEW.id, tr, eval_pair_eval_cols());
      END IF;
    END IF;
  END IF;

  PERFORM eval_pair_refresh_back(NEW.id, t);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_pair_sync ON game_evaluations;
CREATE TRIGGER trg_eval_pair_sync
  AFTER UPDATE ON game_evaluations
  FOR EACH ROW
  WHEN (NEW.pair_eval_id IS NOT NULL AND OLD.pair_eval_id IS NOT DISTINCT FROM NEW.pair_eval_id)
  EXECUTE FUNCTION eval_pair_sync();

-- A deleted row leaves its twin a lone game: the FK (ON DELETE SET NULL) clears the
-- pointer, this clears pair_back, so the twin shows in the lists again.
CREATE OR REPLACE FUNCTION eval_pair_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE game_evaluations SET pair_eval_id = NULL, pair_back = false
   WHERE id = OLD.pair_eval_id
     AND (pair_eval_id IS NULL OR pair_eval_id = OLD.id)
     AND (pair_eval_id IS NOT NULL OR pair_back);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_pair_delete ON game_evaluations;
CREATE TRIGGER trg_eval_pair_delete
  AFTER DELETE ON game_evaluations
  FOR EACH ROW WHEN (OLD.pair_eval_id IS NOT NULL)
  EXECUTE FUNCTION eval_pair_on_delete();

-- Signal Sense unlinks a game or moves it to another family (spec 6.2 c): a linked pair of
-- that game that is no longer valid splits, both rows keep their data. Never links (a
-- family formed after both stores were judged is phase 2).
-- This trigger runs inside Signal Sense's own transaction on ITS table game_info, so it
-- must never fail Signal Sense's UPDATE: any error is a WARNING and its half-done work
-- rolls back with the block. AFTER ROW triggers fire once the statement is done, so a
-- statement that moves both stores to a new family together sees a valid pair and keeps it.
-- SECURITY DEFINER with a fixed search_path: it runs as Signal Sense's role, which may have
-- no grant on game_evaluations / evaluation_log and another search_path; either would turn
-- every split into a WARNING. As the owner (Playtest's role), everything it calls runs with
-- the owner's rights and this search_path (pg_temp last, so no temp object can shadow ours).
CREATE OR REPLACE FUNCTION game_info_eval_pair_unlink() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  BEGIN
    FOR r IN SELECT id, pair_eval_id FROM game_evaluations
              WHERE game_id = NEW.game_id AND pair_eval_id IS NOT NULL LOOP
      IF NOT eval_pair_valid(r.id, r.pair_eval_id) THEN
        PERFORM unlink_eval_pair(r.id);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '054: game % changed family, its Playtest store pair was not split: % (%)',
      NEW.game_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

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

-- The trigger on Signal Sense's game_info, in its own short transaction AFTER the links
-- are committed: CREATE TRIGGER holds ShareRowExclusiveLock (DROP TRIGGER on a re-run:
-- AccessExclusiveLock) on game_info until COMMIT, so inside the transaction above it would
-- stall every Signal Sense write (on a re-run, every read) for the whole safe-pair pass.
-- lock_timeout: if an open Signal Sense transaction holds game_info, give up after 5 s
-- (psql stops with "lock timeout"; the links above are already committed, just re-run the
-- file) instead of queueing an AccessExclusive request that every later game_info query
-- would queue behind. A family change between the two transactions is not lost: the copy
-- trigger finds the pair invalid on its next write and splits it.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_game_info_eval_pair_unlink ON game_info;
CREATE TRIGGER trg_game_info_eval_pair_unlink
  AFTER UPDATE OF family_id, family_unlinked ON game_info
  FOR EACH ROW
  WHEN (OLD.family_id IS DISTINCT FROM NEW.family_id OR OLD.family_unlinked IS DISTINCT FROM NEW.family_unlinked)
  EXECUTE FUNCTION game_info_eval_pair_unlink();

COMMIT;
