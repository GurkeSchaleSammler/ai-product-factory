BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS factory_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  automation_enabled boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT true,
  portfolio_revision bigint NOT NULL DEFAULT 0 CHECK (portfolio_revision >= 0),
  daily_llm_cost_limit_chf numeric(12, 2),
  daily_token_limit bigint,
  build_timeout_seconds integer,
  max_occupied_slots integer NOT NULL DEFAULT 10 CHECK (max_occupied_slots BETWEEN 1 AND 10),
  max_parallel_builds integer NOT NULL DEFAULT 1 CHECK (max_parallel_builds = 1),
  max_development_rounds integer NOT NULL DEFAULT 3 CHECK (max_development_rounds = 3),
  pitch_interval_minutes integer NOT NULL DEFAULT 15 CHECK (pitch_interval_minutes = 15),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (daily_llm_cost_limit_chf IS NULL OR daily_llm_cost_limit_chf > 0),
  CHECK (daily_token_limit IS NULL OR daily_token_limit > 0),
  CHECK (build_timeout_seconds IS NULL OR build_timeout_seconds > 0)
);

INSERT INTO factory_settings (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'RESERVED', 'BUILDING', 'REVIEWING', 'DEPLOYING', 'LIVE',
    'ARCHIVING', 'ARCHIVE_FAILED', 'ARCHIVED', 'NEEDS_HUMAN_REVIEW'
  )),
  score integer CHECK (score BETWEEN 0 AND 100),
  has_real_users boolean NOT NULL DEFAULT false,
  has_persistent_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pitches (
  id uuid PRIMARY KEY,
  window_id text NOT NULL UNIQUE CHECK (window_id ~ '^[0-9]{10}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio_decisions (
  id uuid PRIMARY KEY,
  pitch_id uuid NOT NULL UNIQUE REFERENCES pitches(id),
  portfolio_revision bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS management_commands (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL UNIQUE REFERENCES portfolio_decisions(id),
  idempotency_key text NOT NULL UNIQUE,
  expected_portfolio_revision bigint NOT NULL,
  operation text NOT NULL CHECK (operation IN ('ADMIT', 'REPLACE', 'ARCHIVE')),
  product_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED', 'COMPLETED')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS development_orders (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE REFERENCES management_commands(id),
  idempotency_key text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id),
  payload jsonb NOT NULL,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verified_releases (
  order_id uuid PRIMARY KEY REFERENCES development_orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  leased_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
ON jobs (kind, status, available_at, leased_until, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  subject_id text,
  correlation_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_llm_usage (
  usage_date date PRIMARY KEY,
  cost_chf numeric(12, 4) NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
