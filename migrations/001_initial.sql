-- dashboard_users: separate from Signal-Sense-Pack's `users` table
CREATE TABLE IF NOT EXISTS dashboard_users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255),
  role       VARCHAR(20) NOT NULL CHECK (role IN ('manager', 'evaluator')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops_logs (
  id            SERIAL PRIMARY KEY,
  workflow_name VARCHAR(100) NOT NULL,
  triggered_by  VARCHAR(255),
  status        VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'error')),
  summary       JSONB,
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- game_flow_logs: tracks game volume for both pull (from game_info) and push (to Smartsheet)
--
-- pull rows: flow_type='pull', period='morning'|'afternoon', sheet=NULL
--   morning  = total count in game_info before 14h (checkpoint)
--   afternoon = total count at 16h; delta = afternoon - morning
--
-- push rows: flow_type='push', sheet='puzzle'|'arcade'|'simulation', period=NULL
--   one row per sheet per platform per run
--
-- platform=NULL means combined total; 'ios'/'android' for per-platform breakdown
CREATE TABLE IF NOT EXISTS game_flow_logs (
  id          SERIAL PRIMARY KEY,
  log_date    DATE NOT NULL,
  flow_type   VARCHAR(10) NOT NULL CHECK (flow_type IN ('pull', 'push')),
  period      VARCHAR(20) CHECK (period IN ('morning', 'afternoon')),
  sheet       VARCHAR(50),
  platform    VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (platform IN ('all', 'ios', 'android')),
  count       INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pull_log ON game_flow_logs (log_date, period, platform) WHERE flow_type = 'pull';
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_log ON game_flow_logs (log_date, sheet, platform, period) WHERE flow_type = 'push';

CREATE TABLE IF NOT EXISTS daily_stats (
  id              SERIAL PRIMARY KEY,
  stat_date       DATE NOT NULL,
  evaluator_name  VARCHAR(255),
  games_pulled    INT DEFAULT 0,
  games_pushed    INT DEFAULT 0,
  games_assigned  INT DEFAULT 0,
  games_evaluated INT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (stat_date, evaluator_name)
);
