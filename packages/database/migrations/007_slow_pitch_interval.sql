BEGIN;

ALTER TABLE factory_settings
  DROP CONSTRAINT factory_settings_pitch_interval_minutes_check;

ALTER TABLE factory_settings
  ALTER COLUMN pitch_interval_minutes SET DEFAULT 30;

UPDATE factory_settings
SET pitch_interval_minutes = 30,
    llm_budget_limits_enabled = true,
    updated_at = now()
WHERE singleton = true;

ALTER TABLE factory_settings
  ADD CONSTRAINT factory_settings_pitch_interval_minutes_check
  CHECK (pitch_interval_minutes = 30);

COMMIT;
