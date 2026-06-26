-- 022: manual bucket override for the Record tab. '5min'|'20min' force the
-- game into that container; 'none' removes it from the list; NULL = auto by
-- final_conclusion (Insight→5min, Priority IV→20min).
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS record_bucket TEXT;
