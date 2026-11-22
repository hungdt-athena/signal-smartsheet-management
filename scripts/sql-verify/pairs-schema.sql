-- Throwaway schema for scripts/verify-eval-pairs.sh (migration 054).
-- game_evaluations is `pg_dump -s -t game_evaluations` of the local sample DB
-- (postgres://127.0.0.1:54330/sample, 2026-11-21) without owner/grant/comment lines, so
-- every column the pair copy touches is real. game_info is owned by the Signal Sense repo:
-- only the columns 054 reads are copied. dashboard_users and playtest_tags are stubs that
-- the 046 seed queries need. The two BEFORE UPDATE triggers on game_evaluations are the
-- real ones: update_game_evaluations_timestamp (sample DB) and game_evaluations_record_slots
-- (verbatim from migrations/051_record_per_bucket.sql), because the pair copy runs through them.
SET TIME ZONE 'UTC';

CREATE TABLE game_info (
  game_id text PRIMARY KEY,
  os text,
  family_id text,
  family_unlinked boolean NOT NULL DEFAULT false,
  is_active boolean DEFAULT true,
  demo_code text UNIQUE,
  record_code text UNIQUE,
  title text
);
CREATE INDEX idx_game_info_family_id ON game_info (family_id) WHERE family_id IS NOT NULL;

CREATE TABLE dashboard_users (
  id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, name VARCHAR(255),
  role VARCHAR(20) NOT NULL, title TEXT, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE playtest_tags (
  id serial PRIMARY KEY, game_id varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value text NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by varchar(255) NOT NULL, tagged_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION update_game_evaluations_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

-- From migrations/051_record_per_bucket.sql
CREATE OR REPLACE FUNCTION game_evaluations_record_slots()
RETURNS TRIGGER AS $$
DECLARE
  old_own text := CASE WHEN OLD.record_bucket IN ('5min','20min') THEN OLD.record_bucket
                       WHEN OLD.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END;
  new_own text := CASE WHEN NEW.record_bucket IN ('5min','20min') THEN NEW.record_bucket
                       WHEN NEW.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END;
BEGIN
  -- 1. A write to an old column with the own bucket's column untouched comes from a
  --    build that only knows the old column: carry it into the own bucket.
  IF NEW.record_confirmed_at IS DISTINCT FROM OLD.record_confirmed_at THEN
    IF new_own = '5min' AND NEW.record_5min_confirmed_at IS NOT DISTINCT FROM OLD.record_5min_confirmed_at THEN
      NEW.record_5min_confirmed_at := NEW.record_confirmed_at;
    ELSIF new_own = '20min' AND NEW.record_20min_confirmed_at IS NOT DISTINCT FROM OLD.record_20min_confirmed_at THEN
      NEW.record_20min_confirmed_at := NEW.record_confirmed_at;
    END IF;
  END IF;
  IF NEW.youtube_uploaded_at IS DISTINCT FROM OLD.youtube_uploaded_at THEN
    IF new_own = '5min' AND NEW.youtube_5min_uploaded_at IS NOT DISTINCT FROM OLD.youtube_5min_uploaded_at THEN
      NEW.youtube_5min_uploaded_at := NEW.youtube_uploaded_at;
    ELSIF new_own = '20min' AND NEW.youtube_20min_uploaded_at IS NOT DISTINCT FROM OLD.youtube_20min_uploaded_at THEN
      NEW.youtube_20min_uploaded_at := NEW.youtube_uploaded_at;
    END IF;
  END IF;

  -- 2. The game left a bucket: that round keeps the batch it was in. A round that
  --    already has its video keeps the batch it was first frozen with, so dragging
  --    the game into that bucket and out again does not move it. The bucket it moved
  --    into, if its round is still open, follows ge.batch again.
  IF old_own <> new_own THEN
    IF old_own = '5min' THEN
      IF NEW.youtube_5min_uploaded_at IS NULL OR NEW.record_5min_batch IS NULL THEN
        NEW.record_5min_batch := OLD.batch;
      END IF;
      IF NEW.youtube_20min_uploaded_at IS NULL THEN NEW.record_20min_batch := NULL; END IF;
    ELSE
      IF NEW.youtube_20min_uploaded_at IS NULL OR NEW.record_20min_batch IS NULL THEN
        NEW.record_20min_batch := OLD.batch;
      END IF;
      IF NEW.youtube_5min_uploaded_at IS NULL THEN NEW.record_5min_batch := NULL; END IF;
    END IF;
  END IF;

  -- 3. The old columns always read as the own bucket's round.
  IF new_own = '5min' THEN
    NEW.record_confirmed_at := NEW.record_5min_confirmed_at;
    NEW.youtube_uploaded_at := NEW.youtube_5min_uploaded_at;
  ELSE
    NEW.record_confirmed_at := NEW.record_20min_confirmed_at;
    NEW.youtube_uploaded_at := NEW.youtube_20min_uploaded_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- pg_dump of game_evaluations (sample DB)
CREATE TABLE game_evaluations (
    id integer NOT NULL,
    game_id character varying(255) NOT NULL,
    category_group character varying(20) NOT NULL,
    initial_evaluator character varying(100),
    final_evaluator character varying(100),
    assigned_date date,
    initial_note text,
    initial_conclusion character varying(50),
    drive_link text,
    youtube_link text,
    imported_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    genre_1 character varying(50),
    genre_2 character varying(50),
    evaluate_date timestamp with time zone,
    drive_date timestamp with time zone,
    record_assignee character varying(100),
    record_assign_date timestamp with time zone,
    record_5min_assignee character varying(100),
    record_5min_date timestamp with time zone,
    record_5min_drive text,
    record_5min_drive_date timestamp with time zone,
    record_20min_assignee character varying(100),
    record_20min_date timestamp with time zone,
    record_20min_drive text,
    record_20min_drive_date timestamp with time zone,
    final_conclusion character varying(50),
    batch character varying(40),
    game_alike jsonb DEFAULT '[]'::jsonb NOT NULL,
    final_note text,
    record_confirmed_at timestamp with time zone,
    record_bucket text,
    final_conclusion_date timestamp with time zone,
    updated_by text,
    first_assigned_date date,
    youtube_uploaded_at timestamp with time zone,
    initial_gameplay text,
    initial_game_over text,
    initial_level_complete text,
    initial_self_note text,
    record_5min_confirmed_at timestamp with time zone,
    record_20min_confirmed_at timestamp with time zone,
    youtube_5min_link text,
    youtube_20min_link text,
    youtube_5min_uploaded_at timestamp with time zone,
    youtube_20min_uploaded_at timestamp with time zone,
    record_5min_batch text,
    record_20min_batch text,
    CONSTRAINT game_evaluations_category_group_check CHECK (((category_group)::text = ANY (ARRAY[('puzzle'::character varying)::text, ('arcade'::character varying)::text, ('simulation'::character varying)::text])))
);

CREATE SEQUENCE game_evaluations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE game_evaluations_id_seq OWNED BY game_evaluations.id;

ALTER TABLE ONLY game_evaluations ALTER COLUMN id SET DEFAULT nextval('game_evaluations_id_seq'::regclass);

ALTER TABLE ONLY game_evaluations
    ADD CONSTRAINT game_evaluations_game_id_category_group_key UNIQUE (game_id, category_group);

ALTER TABLE ONLY game_evaluations
    ADD CONSTRAINT game_evaluations_pkey PRIMARY KEY (id);

CREATE INDEX idx_game_evaluations_batch ON game_evaluations USING btree (batch) WHERE (batch IS NOT NULL);

CREATE INDEX idx_game_evaluations_cat_assigned ON game_evaluations USING btree (category_group, assigned_date DESC);

CREATE INDEX idx_game_evaluations_category ON game_evaluations USING btree (category_group);

CREATE INDEX idx_game_evaluations_conclusion ON game_evaluations USING btree (initial_conclusion) WHERE (initial_conclusion IS NOT NULL);

CREATE INDEX idx_game_evaluations_final_conclusion ON game_evaluations USING btree (final_conclusion) WHERE (final_conclusion IS NOT NULL);

CREATE INDEX idx_game_evaluations_final_evaluator ON game_evaluations USING btree (final_evaluator) WHERE (final_evaluator IS NOT NULL);

CREATE INDEX idx_game_evaluations_first_assigned ON game_evaluations USING btree (first_assigned_date) WHERE (first_assigned_date IS NOT NULL);

CREATE INDEX idx_game_evaluations_imported ON game_evaluations USING btree (imported_at DESC);

CREATE INDEX idx_game_evaluations_initial_evaluator ON game_evaluations USING btree (initial_evaluator) WHERE (initial_evaluator IS NOT NULL);

CREATE INDEX idx_game_evaluations_record_20min ON game_evaluations USING btree (record_20min_assignee) WHERE (record_20min_assignee IS NOT NULL);

CREATE INDEX idx_game_evaluations_record_5min ON game_evaluations USING btree (record_5min_assignee) WHERE (record_5min_assignee IS NOT NULL);

CREATE INDEX idx_game_evaluations_recorded_20min_at ON game_evaluations USING btree (COALESCE(record_20min_confirmed_at, youtube_20min_uploaded_at));

CREATE INDEX idx_game_evaluations_recorded_5min_at ON game_evaluations USING btree (COALESCE(record_5min_confirmed_at, youtube_5min_uploaded_at));

CREATE INDEX idx_game_evaluations_recorded_at ON game_evaluations USING btree (COALESCE(record_confirmed_at, youtube_uploaded_at));

CREATE INDEX idx_game_evaluations_unassigned ON game_evaluations USING btree (category_group, assigned_date) WHERE (initial_evaluator IS NULL);

CREATE INDEX idx_ge_cat_evalcoalesce ON game_evaluations USING btree (category_group, COALESCE(evaluate_date, updated_at) DESC);

CREATE INDEX idx_ge_evaluate_date ON game_evaluations USING btree (evaluate_date) WHERE (evaluate_date IS NOT NULL);

CREATE TRIGGER trg_game_evaluations_record_slots BEFORE UPDATE ON game_evaluations FOR EACH ROW EXECUTE FUNCTION game_evaluations_record_slots();

CREATE TRIGGER trg_game_evaluations_updated BEFORE UPDATE ON game_evaluations FOR EACH ROW EXECUTE FUNCTION update_game_evaluations_timestamp();

ALTER TABLE ONLY game_evaluations
    ADD CONSTRAINT game_evaluations_game_id_fkey FOREIGN KEY (game_id) REFERENCES game_info(game_id) ON DELETE CASCADE;
