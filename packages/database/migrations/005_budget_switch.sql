BEGIN;
ALTER TABLE factory_settings ADD COLUMN llm_budget_limits_enabled boolean NOT NULL DEFAULT true;
COMMIT;
