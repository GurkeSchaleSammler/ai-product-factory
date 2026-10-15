BEGIN;
ALTER TABLE factory_settings DROP CONSTRAINT factory_settings_pitch_interval_minutes_check;
ALTER TABLE factory_settings ADD CONSTRAINT factory_settings_pitch_interval_minutes_check
  CHECK (pitch_interval_minutes IN (1, 15));
COMMIT;
