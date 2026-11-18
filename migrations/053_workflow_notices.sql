-- Migration 053: which n8n notices were already posted
-- The code-file workflows (drive-video-link-sync [by-code], Append Sheet [by-code]) list the last days of
-- the Drive folder on every run, so a file left as it is would be reported again each run. They used
-- workflow static data to remember what was sent, but on n8n cloud the Code node reads it back empty, and
-- the same Chat message came every run. A notice is now posted only when its key is inserted here.
-- key = '<workflow>|<status>|<drive file id>'.
CREATE TABLE IF NOT EXISTS workflow_notices (
  key      text PRIMARY KEY,
  workflow text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT NOW()
);
