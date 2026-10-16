BEGIN;
UPDATE factory_settings
SET pitch_interval_minutes = 15,
    updated_at = now()
WHERE singleton = true;
COMMIT;
