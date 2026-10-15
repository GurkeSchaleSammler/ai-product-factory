import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg, { type Pool, type PoolClient } from "pg";

const { Pool: PgPool } = pg;

export type Database = Pool;
export type Transaction = PoolClient;

export interface FactorySettings {
  automationEnabled: boolean;
  emergencyStop: boolean;
  portfolioRevision: number;
  dailyLlmCostLimitChf: number | null;
  llmBudgetLimitsEnabled: boolean;
  dailyTokenLimit: number | null;
  buildTimeoutSeconds: number | null;
  maxOccupiedSlots: number;
  maxParallelBuilds: number;
  maxDevelopmentRounds: number;
  pitchIntervalMinutes: number;
}

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

export function createDatabase(connectionString: string, applicationName: string): Database {
  return new PgPool({
    connectionString,
    application_name: applicationName,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withTransaction<T>(
  database: Database,
  work: (client: Transaction) => Promise<T>,
  isolationLevel: "READ COMMITTED" | "SERIALIZABLE" = "READ COMMITTED",
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDatabase(database: Database): Promise<void> {
  await database.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await database.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await database.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    await database.query(sql);
    await database.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
  }
}

export async function getFactorySettings(client: Database | Transaction): Promise<FactorySettings> {
  const result = await client.query<{
    automation_enabled: boolean;
    emergency_stop: boolean;
    portfolio_revision: string;
    daily_llm_cost_limit_chf: string | null;
    llm_budget_limits_enabled: boolean;
    daily_token_limit: string | null;
    build_timeout_seconds: number | null;
    max_occupied_slots: number;
    max_parallel_builds: number;
    max_development_rounds: number;
    pitch_interval_minutes: number;
  }>("SELECT * FROM factory_settings WHERE singleton = true");
  const row = result.rows[0];
  if (!row) throw new Error("factory_settings singleton is missing");
  return {
    automationEnabled: row.automation_enabled,
    emergencyStop: row.emergency_stop,
    portfolioRevision: Number(row.portfolio_revision),
    dailyLlmCostLimitChf: row.daily_llm_cost_limit_chf === null ? null : Number(row.daily_llm_cost_limit_chf),
    llmBudgetLimitsEnabled: row.llm_budget_limits_enabled,
    dailyTokenLimit: row.daily_token_limit === null ? null : Number(row.daily_token_limit),
    buildTimeoutSeconds: row.build_timeout_seconds,
    maxOccupiedSlots: row.max_occupied_slots,
    maxParallelBuilds: row.max_parallel_builds,
    maxDevelopmentRounds: row.max_development_rounds,
    pitchIntervalMinutes: row.pitch_interval_minutes,
  };
}

export function settingsPermitNewWork(settings: FactorySettings): boolean {
  return settings.automationEnabled
    && !settings.emergencyStop
    && (!settings.llmBudgetLimitsEnabled ||
      (settings.dailyLlmCostLimitChf !== null && settings.dailyTokenLimit !== null))
    && settings.buildTimeoutSeconds !== null;
}

export async function reserveLlmBudget(
  database: Database,
  estimatedCostChf: number,
  reservedTokens: number,
): Promise<boolean> {
  return withTransaction(database, async (client) => {
    const settings = await getFactorySettings(client);
    if (!settingsPermitNewWork(settings)) return false;
    await client.query(
      `INSERT INTO daily_llm_usage(usage_date) VALUES (CURRENT_DATE)
       ON CONFLICT (usage_date) DO NOTHING`,
    );
    const result = await client.query(
      `UPDATE daily_llm_usage
       SET cost_chf = cost_chf + $1,
           tokens = tokens + $2,
           updated_at = now()
       WHERE usage_date = CURRENT_DATE
         AND (NOT $5::boolean OR (cost_chf + $1 <= $3 AND tokens + $2 <= $4))`,
      [estimatedCostChf, reservedTokens, settings.dailyLlmCostLimitChf, settings.dailyTokenLimit, settings.llmBudgetLimitsEnabled],
    );
    return result.rowCount === 1;
  }, "SERIALIZABLE");
}

export async function claimJob(
  database: Database,
  kinds: readonly string[],
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedJob | null> {
  const result = await database.query<{
    id: string;
    kind: string;
    payload: unknown;
    idempotency_key: string;
    attempts: number;
    max_attempts: number;
  }>(
    `WITH candidate AS (
       SELECT id
       FROM jobs
       WHERE kind = ANY($1::text[])
         AND available_at <= now()
         AND (
           status = 'PENDING'
           OR (status = 'RUNNING' AND leased_until < now())
         )
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs AS job
     SET status = 'RUNNING',
         leased_by = $2,
         leased_until = now() + make_interval(secs => $3),
         attempts = attempts + 1,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.kind, job.payload, job.idempotency_key,
               job.attempts, job.max_attempts`,
    [kinds, workerId, leaseSeconds],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  } : null;
}

export async function completeJob(database: Database, jobId: string, workerId: string): Promise<void> {
  const result = await database.query(
    `UPDATE jobs
     SET status = 'COMPLETED', leased_until = NULL, leased_by = NULL, updated_at = now()
     WHERE id = $1 AND status = 'RUNNING' AND leased_by = $2`,
    [jobId, workerId],
  );
  if (result.rowCount !== 1) throw new Error(`job ${jobId} lease was lost`);
}

export async function failJob(
  database: Database,
  job: ClaimedJob,
  workerId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.maxAttempts;
  const retrySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await database.query(
    `UPDATE jobs
     SET status = $3,
         available_at = CASE WHEN $3 = 'PENDING' THEN now() + make_interval(secs => $4) ELSE available_at END,
         leased_until = NULL,
         leased_by = NULL,
         last_error = $5,
         updated_at = now()
     WHERE id = $1 AND leased_by = $2`,
    [job.id, workerId, terminal ? "DEAD" : "PENDING", retrySeconds, message.slice(0, 4000)],
  );
}

export async function deferJob(
  database: Database,
  jobId: string,
  workerId: string,
  delaySeconds: number,
  reason: string,
): Promise<void> {
  await database.query(
    `UPDATE jobs
     SET status = 'PENDING',
         attempts = GREATEST(0, attempts - 1),
         available_at = now() + make_interval(secs => $3),
         leased_until = NULL,
         leased_by = NULL,
         last_error = $4,
         updated_at = now()
     WHERE id = $1 AND leased_by = $2`,
    [jobId, workerId, delaySeconds, reason.slice(0, 4000)],
  );
}

export async function writeAudit(
  client: Database | Transaction,
  actorId: string,
  action: string,
  subjectId: string | null,
  correlationId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log(actor_id, action, subject_id, correlation_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, subjectId, correlationId, JSON.stringify(details)],
  );
}

export async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
