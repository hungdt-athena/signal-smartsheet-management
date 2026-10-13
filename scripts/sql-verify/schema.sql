-- Minimal copies of the prod tables evaluation_log touches. Columns and types follow
-- migrations 001/002/005/006/008/012/020-025/032/035/038/041/044. game_info is owned by the
-- Signal Sense repo, so only its key is copied.
SET TIME ZONE 'UTC';
CREATE TABLE game_info (game_id VARCHAR(255) PRIMARY KEY);
CREATE TABLE dashboard_users (
  id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, name VARCHAR(255),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','moderator','evaluator')),
  title TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE game_evaluations (
  id SERIAL PRIMARY KEY,
  game_id VARCHAR(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  category_group VARCHAR(20) NOT NULL DEFAULT 'puzzle',
  initial_evaluator VARCHAR(100), final_evaluator VARCHAR(100),
  evaluate_date TIMESTAMPTZ, initial_note TEXT, initial_conclusion VARCHAR(50),
  final_conclusion VARCHAR(50), final_conclusion_date TIMESTAMPTZ, batch VARCHAR(40),
  record_bucket TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT,
  record_5min_assignee VARCHAR(100), record_5min_date TIMESTAMPTZ,
  record_20min_assignee VARCHAR(100), record_20min_date TIMESTAMPTZ,
  record_confirmed_at TIMESTAMPTZ, drive_link TEXT,
  UNIQUE (game_id, category_group));
CREATE TABLE playtest_tags (
  id serial PRIMARY KEY,
  game_id varchar(255) NOT NULL REFERENCES game_info(game_id) ON DELETE CASCADE,
  field_value text NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending',
  tagged_by varchar(255) NOT NULL, tagged_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE assignment_history (
  id SERIAL PRIMARY KEY, run_date DATE NOT NULL, run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category_group TEXT NOT NULL, action TEXT NOT NULL, evaluator_name TEXT NOT NULL,
  from_evaluator TEXT, game_count INT NOT NULL, game_ids TEXT[] NOT NULL DEFAULT '{}',
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW());

INSERT INTO dashboard_users (email, name, role, title) VALUES
 ('alice@x','Alice','evaluator','Freelancer'), ('bob@x','Bob','evaluator','Fulltime'),
 ('carol@x','Carol','evaluator','Freelancer'), ('dave@x','Dave','evaluator','Fulltime'),
 ('hung@x','HungDT','admin','Admin'), ('vinh@x','VinhTD','moderator','Admin');
