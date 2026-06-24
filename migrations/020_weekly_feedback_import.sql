-- Migration 020: Weekly Feedback import staging (THROWAWAY)
-- One-off table holding feedback parsed from the legacy Google Sheet, awaiting
-- admin review + approve. Approving copies `sections` into the live
-- weekly_feedback table. Drop this table (and the import script + Import tab)
-- once the historical sync is done — it is not part of the product.
--
-- `sections` mirrors weekly_feedback.sections:
--   [{ id, feedback: <tiptap doc|null>,
--      alikes: [{ name, games: [{ game_id, title, app_link, icon_url, manual }] }] }]

CREATE TABLE IF NOT EXISTS weekly_feedback_import (
  id          SERIAL PRIMARY KEY,
  batch       VARCHAR(40)  NOT NULL,
  evaluator   VARCHAR(100) NOT NULL,
  sections    JSONB        NOT NULL,
  status      VARCHAR(12)  NOT NULL DEFAULT 'pending', -- 'pending' | 'approved'
  source_tab  VARCHAR(100),
  imported_at TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (batch, evaluator)
);

CREATE INDEX IF NOT EXISTS idx_wf_import_status ON weekly_feedback_import (status, evaluator);

-- Teardown when finished:
--   DROP TABLE IF EXISTS weekly_feedback_import;
