CREATE TABLE IF NOT EXISTS users (
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
