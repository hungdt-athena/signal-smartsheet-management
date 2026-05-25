CREATE TABLE IF NOT EXISTS smartsheet_webhooks (
  id            SERIAL PRIMARY KEY,
  sheet_name    VARCHAR(50) NOT NULL,
  sheet_id      VARCHAR(100) NOT NULL,
  webhook_id    VARCHAR(100) NOT NULL UNIQUE,
  shared_secret VARCHAR(255) NOT NULL,
  enabled       BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS smartsheet_delete_events (
  id            SERIAL PRIMARY KEY,
  sheet_name    VARCHAR(50) NOT NULL,
  row_id        BIGINT,
  deleted_by    VARCHAR(100),
  event_ts      TIMESTAMPTZ NOT NULL,
  notified      BOOLEAN DEFAULT false,
  suppressed    BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
