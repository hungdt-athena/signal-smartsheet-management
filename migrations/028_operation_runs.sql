-- Migration 028: operation_runs — one row per reassign/handover operation.
--
-- Contrast assignment_history (migration 025), which is one row per evaluator per
-- run. operation_runs is one row per OPERATION, carrying a full DistResult-shaped
-- snapshot (source pool by day/platform + the resulting per-evaluator distribution)
-- so the Team Operations "Details" popup can re-render exactly what was previewed —
-- without re-querying game state that may have since changed.
--
-- Reassign commits immediately and writes status='committed'. Handover is now an
-- approval workflow: submit writes status='pending' (NO game changes); a manager
-- approves (redistribution runs, status='approved', committed result stored) or
-- rejects (status='rejected'). game_evaluations / assignment_history / handover_requests
-- are only touched on approve.

CREATE TABLE IF NOT EXISTS operation_runs (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,                       -- 'reassign' | 'handover'
  category_group TEXT NOT NULL,                       -- puzzle | arcade | simulation
  from_evaluator TEXT NOT NULL,                       -- source evaluator
  params         JSONB NOT NULL DEFAULT '{}',         -- mode, start/end date, count, selected_evaluators, weights
  snapshot       JSONB NOT NULL DEFAULT '{}',         -- DistResult at submit/commit time
  result         JSONB,                               -- committed DistResult (handover approve); NULL until then
  status         TEXT NOT NULL,                       -- reassign: 'committed' | handover: pending|approved|rejected
  game_count     INT NOT NULL DEFAULT 0,              -- assigned (committed) or assignable (pending)
  submitted_by   TEXT,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by    TEXT,                                -- who approved/rejected (handover)
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- List query: newest-first within (kind, bucket).
CREATE INDEX IF NOT EXISTS idx_operation_runs_list
  ON operation_runs (kind, category_group, submitted_at DESC);
-- Pending handover queue lookups.
CREATE INDEX IF NOT EXISTS idx_operation_runs_pending
  ON operation_runs (status, submitted_at DESC) WHERE status = 'pending';
