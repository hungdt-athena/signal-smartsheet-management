-- Migration 030: report_rollup — precomputed weekly analytics for the Report tab.
--
-- One row per (period_week, category_group, domain, evaluator). Populated by the
-- POST /api/cron/report-rollup job (weekly freeze + current-week recompute) and
-- read by GET /api/report. Time is anchored on real timestamps, NOT the sparse
-- game_evaluations.batch label: evaluation weeks come from evaluate_date, recording
-- weeks from record_confirmed_at, both truncated to Monday in Asia/Ho_Chi_Minh.
--
-- Averages are stored as sum + count components so Month/Quarter/Overall views can
-- re-derive the average by SUM()ing weeks (never averaging pre-averaged values).

CREATE TABLE IF NOT EXISTS report_rollup (
  period_week      DATE         NOT NULL,          -- Monday of the ISO week (VN tz)
  period_month     TEXT         NOT NULL,          -- 'YYYY-MM'
  period_quarter   TEXT         NOT NULL,          -- 'YYYY-Qn'
  category_group   VARCHAR(20)  NOT NULL,          -- puzzle | arcade | simulation
  domain           VARCHAR(12)  NOT NULL,          -- 'evaluation' | 'recording'
  evaluator        VARCHAR(100) NOT NULL,          -- display name
  evaluator_key    VARCHAR(100) NOT NULL,          -- lower(evaluator) grouping key
  games            INT          NOT NULL DEFAULT 0,
  active_days      INT          NOT NULL DEFAULT 0,
  turnaround_sum   NUMERIC      NOT NULL DEFAULT 0, -- Σ days assign→complete
  turnaround_count INT          NOT NULL DEFAULT 0,
  priority_count   INT          NOT NULL DEFAULT 0, -- evaluation only (Priority* conclusions)
  conclusions      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  computed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (period_week, category_group, domain, evaluator_key)
);

CREATE INDEX IF NOT EXISTS idx_report_rollup_month
  ON report_rollup (domain, period_month);
CREATE INDEX IF NOT EXISTS idx_report_rollup_quarter
  ON report_rollup (domain, period_quarter);
CREATE INDEX IF NOT EXISTS idx_report_rollup_evaluator
  ON report_rollup (domain, evaluator_key);
