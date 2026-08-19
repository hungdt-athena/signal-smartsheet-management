-- Migration 037: keep what the evaluator actually proposed, and why the admin
-- changed it.
--
-- PATCH /api/playtest-tags/[id] corrects a pending proposal by writing over
-- field_value / sub_value_id, so the evaluator's own version was gone the moment
-- an admin touched it. History could then only ever show the corrected tag, and
-- the evaluator had no way to see that a correction had happened at all — which
-- is the one thing worth learning from.
--
-- original_* is snapshotted ONCE, on the first edit of a row, and never again:
-- three corrections in a row still compare against what the evaluator sent, not
-- against the previous correction.
--
-- original_captured_at is the flag, not decoration. Without it, a NULL
-- original_sub_value_id cannot be told apart from "never edited" — and "the
-- evaluator proposed no sub-value" is a real, common case that history must be
-- able to state.
--
-- review_note is the admin's optional line at confirm or reject time, shown to
-- the evaluator in History next to the diff. Optional by design: making it
-- mandatory would slow the review queue, and the diff already tells the
-- evaluator that something changed.
--
-- No backfill. Rows reviewed before this migration read as "not edited", which
-- is all that can honestly be said about them.

ALTER TABLE playtest_tags
  ADD COLUMN IF NOT EXISTS original_field_value  text,
  ADD COLUMN IF NOT EXISTS original_sub_value_id integer REFERENCES sub_value_definitions(id),
  ADD COLUMN IF NOT EXISTS original_captured_at  timestamptz,
  ADD COLUMN IF NOT EXISTS review_note           text;
