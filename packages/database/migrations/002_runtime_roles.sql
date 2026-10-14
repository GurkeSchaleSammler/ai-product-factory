BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory_innovation') THEN
    CREATE ROLE factory_innovation NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory_sales') THEN
    CREATE ROLE factory_sales NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'factory_manager') THEN
    CREATE ROLE factory_manager NOLOGIN;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO factory_innovation, factory_sales, factory_manager;

GRANT SELECT ON factory_settings, products, pitches, daily_llm_usage TO factory_innovation;
GRANT INSERT ON pitches, jobs, audit_log, daily_llm_usage TO factory_innovation;
GRANT UPDATE ON daily_llm_usage TO factory_innovation;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO factory_innovation;

GRANT SELECT ON factory_settings, products, pitches, portfolio_decisions, daily_llm_usage, jobs TO factory_sales;
GRANT INSERT ON portfolio_decisions, jobs, audit_log, daily_llm_usage TO factory_sales;
GRANT UPDATE ON jobs, daily_llm_usage TO factory_sales;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO factory_sales;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO factory_manager;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO factory_manager;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY innovation_jobs_select ON jobs FOR SELECT TO factory_innovation
  USING (kind = 'evaluate_pitch');
CREATE POLICY innovation_jobs_insert ON jobs FOR INSERT TO factory_innovation
  WITH CHECK (kind = 'evaluate_pitch');

CREATE POLICY sales_jobs_select ON jobs FOR SELECT TO factory_sales
  USING (kind = 'evaluate_pitch');
CREATE POLICY sales_jobs_update ON jobs FOR UPDATE TO factory_sales
  USING (kind = 'evaluate_pitch') WITH CHECK (kind = 'evaluate_pitch');
CREATE POLICY sales_jobs_insert ON jobs FOR INSERT TO factory_sales
  WITH CHECK (kind = 'evaluate_decision');

CREATE POLICY manager_jobs_all ON jobs FOR ALL TO factory_manager
  USING (kind IN ('evaluate_decision', 'dispatch_development_order', 'deploy_release'))
  WITH CHECK (kind IN ('evaluate_decision', 'dispatch_development_order', 'deploy_release'));

COMMIT;
