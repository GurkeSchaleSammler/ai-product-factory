BEGIN;

-- The idempotent decision insert uses ON CONFLICT DO UPDATE on pitch_id.
GRANT UPDATE (pitch_id) ON portfolio_decisions TO factory_sales;

-- ON CONFLICT also checks visibility of the outgoing manager job.
ALTER POLICY sales_jobs_select ON jobs TO factory_sales
  USING (kind IN ('evaluate_pitch', 'evaluate_decision'));

COMMIT;
