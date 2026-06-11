-- Migration 008: Mirror Google Sheet data into Postgres (sheet → DB, step 1: schema)
--
-- Creates the tables that will replace the Google Sheets currently read via
-- lib/google-sheets.ts and the n8n-managed evaluator lists. This migration ONLY
-- creates the schema. Old data is loaded once via POST /api/admin/backfill-sheets.
-- Switching the app + n8n to read/write these tables is a separate later step,
-- so for now these tables have no live writers other than the backfill.

-- 1. ytb_uploads ← sheet `ytb_uploaded`
CREATE TABLE IF NOT EXISTS ytb_uploads (
  id          SERIAL PRIMARY KEY,
  file_id     TEXT,
  uploaded_at TIMESTAMPTZ,          -- sheet column `time`
  status      VARCHAR(30),
  file_name   TEXT,
  youtube_id  TEXT,
  game_title  TEXT,
  pic         VARCHAR(100),         -- evaluator / recorder
  duration    VARCHAR(20),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Plain index for now; promote to UNIQUE when n8n upserts by file_id (later step).
CREATE INDEX IF NOT EXISTS idx_ytb_uploads_file_id ON ytb_uploads(file_id) WHERE file_id IS NOT NULL AND file_id <> '';
CREATE INDEX IF NOT EXISTS idx_ytb_uploads_status ON ytb_uploads(status);

-- 2. operation_logs ← sheet `flow_log`  (distinct from existing game_flow_logs)
CREATE TABLE IF NOT EXISTS operation_logs (
  id         SERIAL PRIMARY KEY,
  log_date   TIMESTAMPTZ,          -- sheet column `date`
  name       VARCHAR(100),
  status     VARCHAR(30),
  note       TEXT,
  sheet_id   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_date ON operation_logs(log_date DESC);

-- 3. workflow_status ← sheet `realtime`  (key/value)
CREATE TABLE IF NOT EXISTS workflow_status (
  workflow   VARCHAR(100) PRIMARY KEY,
  status     VARCHAR(30) NOT NULL DEFAULT 'idle',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. handover_requests ← sheets `handover_puzzle` + `Logging`
CREATE TABLE IF NOT EXISTS handover_requests (
  id             SERIAL PRIMARY KEY,
  request_date   TIMESTAMPTZ,        -- sheet column `date`
  evaluator_name VARCHAR(100),
  start_date     DATE,
  end_date       DATE,
  sheet_type     VARCHAR(20),        -- puzzle / arcade / simulation
  status         VARCHAR(30),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handover_requests_evaluator ON handover_requests(evaluator_name);

-- 5. app_config ← sheet `routing` (+ future flags)  (key/value)
CREATE TABLE IF NOT EXISTS app_config (
  key        VARCHAR(50) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. evaluator_roster ← n8n team/initial + team/final lists
CREATE TABLE IF NOT EXISTS evaluator_roster (
  id              SERIAL PRIMARY KEY,
  list_type       VARCHAR(10) NOT NULL CHECK (list_type IN ('initial', 'final')),
  name            VARCHAR(100) NOT NULL,
  today_available BOOLEAN DEFAULT TRUE,   -- initial list only
  game_platform   VARCHAR(20),            -- initial list only: all / ios / android
  game_category   VARCHAR(50),            -- initial list only
  sort_order      INT,                    -- preserve original sheet row order
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (list_type, name)
);
