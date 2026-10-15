import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  developmentOrderSchema,
  occupiedProductStates,
  portfolioDecisionSchema,
  productPitchSchema,
} from "@factory/contracts";
import {
  claimJob,
  completeJob,
  createDatabase,
  deferJob,
  failJob,
  getFactorySettings,
  migrateDatabase,
  wait,
  withTransaction,
  writeAudit,
  type Transaction,
} from "@factory/database";
import Fastify from "fastify";
import { z } from "zod";
import { GitHubWriter } from "./github.js";
import { evaluatePolicy, type Incumbent } from "./policy.js";
import { discoverRelease, publishRelease, validateRelease, verifyImage } from "./release.js";
import { applicationReady, frontendReady } from "./cluster.js";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  RUN_MIGRATIONS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  GITHUB_TOKEN: z.string().min(20),
  GITHUB_INFRA_TOKEN: z.string().min(20).optional(),
  RELEASE_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  PRODUCT_BASE_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/).default("gurkeschale.ch"),
  DEEPSEEK_API_KEY: z.string().min(1),
  GITHUB_PRODUCT_OWNER: z.string().min(1).default("sechssiebe67-wq"),
  GITHUB_PIPELINE_OWNER: z.string().min(1).optional(),
  GITHUB_PIPELINE_REPOSITORY: z.string().min(1).default("empty-produkt"),
  GITHUB_PIPELINE_BRANCH: z.string().min(1).default("main"),
  GITHUB_PRODUCT_REPOSITORIES_PRIVATE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_HELM_REPOSITORY: z.string().min(1).default("homelab-helm"),
  GITHUB_GITOPS_REPOSITORY: z.string().min(1).default("homelab-gitops"),
  GITHUB_TARGET_BRANCH: z.string().min(1).default("main"),
});

const config = configSchema.parse(process.env);
const app = Fastify({ logger: { level: config.LOG_LEVEL, name: "manager-man" } });
const database = createDatabase(config.DATABASE_URL, "manager-man");
const workerId = `manager-man:${hostname()}:${process.pid}`;
const controller = new AbortController();
const github = new GitHubWriter({
  token: config.GITHUB_TOKEN,
  infraToken: config.GITHUB_INFRA_TOKEN,
  owner: config.GITHUB_OWNER,
  helmRepository: config.GITHUB_HELM_REPOSITORY,
  gitopsRepository: config.GITHUB_GITOPS_REPOSITORY,
  branch: config.GITHUB_TARGET_BRANCH,
  productOwner: config.GITHUB_PRODUCT_OWNER,
  pipelineOwner: config.GITHUB_PIPELINE_OWNER,
  pipelineRepository: config.GITHUB_PIPELINE_REPOSITORY,
  pipelineBranch: config.GITHUB_PIPELINE_BRANCH,
  productRepositoriesPrivate: config.GITHUB_PRODUCT_REPOSITORIES_PRIVATE,
  productSecrets: {
    TAMBINOS_PAT: config.GITHUB_TOKEN,
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
  },
});

async function pollReleases(): Promise<void> {
  const settings = await getFactorySettings(database);
  if (!settings.automationEnabled || settings.emergencyStop) return;
  const { rows } = await database.query<{ id: string; slug: string; status: string }>(
    "SELECT id,slug,status FROM products WHERE status IN ('BUILDING','REVIEWING','DEPLOYING','LIVE')");
  for (const product of rows) {
    try {
      const repository = `${config.GITHUB_PRODUCT_OWNER}/${product.slug}`;
      await github.ensureReleaseWorkflow(repository);
      const release = await discoverRelease(github, repository);
      if (release) {
        await database.query(`INSERT INTO jobs(kind,payload,idempotency_key)
          VALUES ('deploy_release',$1::jsonb,$2) ON CONFLICT (idempotency_key) DO NOTHING`,
        [JSON.stringify({ productId: product.id, release }), `release:${product.id}:${release.sourceCommit}`]);
      }
      if (product.status === "DEPLOYING") {
        const stored = await database.query<{ payload: { helmCommit?: string; sourceCommit: string } }>(
          "SELECT payload FROM verified_releases WHERE product_id=$1 ORDER BY received_at DESC LIMIT 1", [product.id]);
        const current = stored.rows[0]?.payload;
        if (current?.helmCommit && await applicationReady(product.slug, current.helmCommit) && await frontendReady(product.slug, config.PRODUCT_BASE_DOMAIN)) {
          await withTransaction(database, async (client) => {
            await client.query("UPDATE products SET status='LIVE',updated_at=now() WHERE id=$1 AND status='DEPLOYING'", [product.id]);
            await client.query("UPDATE management_commands SET status='COMPLETED',updated_at=now() WHERE product_id=$1 AND status='ACCEPTED'", [product.id]);
            await writeAudit(client, "manager-man", "product.live", product.id, current.sourceCommit,
              { url: `https://${product.slug}.${config.PRODUCT_BASE_DOMAIN}`, revision: current.helmCommit });
          });
          app.log.info({ slug: product.slug }, "product is live");
        }
      }
    } catch (error) { app.log.warn({ err: error, slug: product.slug }, "release reconciliation will retry"); }
  }
}

async function deployRelease(payload: unknown, correlationId: string): Promise<void> {
  const input = z.object({ productId: z.string().uuid(), release: z.unknown() }).parse(payload);
  const { rows } = await database.query<{ slug: string; order_id: string }>(
    `SELECT p.slug,o.id AS order_id FROM products p JOIN development_orders o ON o.product_id=p.id WHERE p.id=$1`, [input.productId]);
  const product = rows[0];
  if (!product) throw new Error("release product has no development order");
  const release = validateRelease(input.release, `${config.GITHUB_PRODUCT_OWNER}/${product.slug}`);
  await github.verifyCommit(release.sourceRepository, release.sourceCommit);
  await verifyImage(release, config.GITHUB_TOKEN);
  const helmCommit = await publishRelease(github, release, product.slug, config.GITHUB_HELM_REPOSITORY,
    config.GITHUB_GITOPS_REPOSITORY, config.GITHUB_OWNER, correlationId, config.PRODUCT_BASE_DOMAIN);
  await withTransaction(database, async (client) => {
    await client.query(`INSERT INTO verified_releases(order_id,product_id,payload) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(order_id) DO UPDATE SET payload=EXCLUDED.payload,received_at=now()`,
    [product.order_id, input.productId, JSON.stringify({ ...release, helmCommit })]);
    await client.query("UPDATE products SET status='DEPLOYING',has_persistent_data=true,updated_at=now() WHERE id=$1", [input.productId]);
    await writeAudit(client,"manager-man","release.published",input.productId,correlationId,{...release,helmCommit});
  });
  app.log.info({ slug: product.slug, helmCommit }, "product deployment published");
}

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_request, reply) => {
  try {
    await database.query("SELECT 1");
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "not-ready" });
  }
});

async function countWork(client: Transaction | typeof database): Promise<{ occupiedSlots: number; activeBuilds: number }> {
  const result = await client.query<{ occupied_slots: string; active_builds: string }>(
    `SELECT
       count(*) FILTER (WHERE status = ANY($1::text[])) AS occupied_slots,
       count(*) FILTER (WHERE status IN ('RESERVED', 'BUILDING', 'REVIEWING')) AS active_builds
     FROM products`,
    [occupiedProductStates],
  );
  return {
    occupiedSlots: Number(result.rows[0]?.occupied_slots ?? 0),
    activeBuilds: Number(result.rows[0]?.active_builds ?? 0),
  };
}

async function loadIncumbent(productId: string | undefined): Promise<Incumbent | null> {
  if (!productId) return null;
  const result = await database.query<{
    id: string;
    score: number | null;
    has_real_users: boolean;
    has_persistent_data: boolean;
    created_at: Date;
  }>(
    `SELECT id, score, has_real_users, has_persistent_data, created_at
     FROM products WHERE id = $1 AND status <> 'ARCHIVED'`,
    [productId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    score: row.score,
    hasRealUsers: row.has_real_users,
    hasPersistentData: row.has_persistent_data,
    createdAt: row.created_at,
  } : null;
}

async function evaluateDecisionJob(jobPayload: unknown, correlationId: string): Promise<void> {
  const { decisionId } = z.object({ decisionId: z.string().uuid() }).parse(jobPayload);
  const result = await database.query<{ decision: unknown; pitch: unknown }>(
    `SELECT decision.payload AS decision, pitch.payload AS pitch
     FROM portfolio_decisions decision
     JOIN pitches pitch ON pitch.id = decision.pitch_id
     WHERE decision.id = $1`,
    [decisionId],
  );
  const decision = portfolioDecisionSchema.parse(result.rows[0]?.decision);
  const pitch = productPitchSchema.parse(result.rows[0]?.pitch);
  const incumbent = await loadIncumbent(decision.replacement?.productId);
  const settings = await getFactorySettings(database);
  const work = await countWork(database);
  const initialPolicy = evaluatePolicy({ settings, decision, pitch, ...work, incumbent });
  if (!initialPolicy.approved) {
    await writeAudit(database, "manager-man", "decision.rejected", decision.id, correlationId, {
      reason: initialPolicy.reason,
    });
    app.log.info({ decisionId, reason: initialPolicy.reason }, "decision rejected by policy");
    return;
  }

  await withTransaction(database, async (client) => {
    await client.query("SELECT singleton FROM factory_settings WHERE singleton = true FOR UPDATE");
    const currentSettings = await getFactorySettings(client);
    const currentWork = await countWork(client);
    const policy = evaluatePolicy({ settings: currentSettings, decision, pitch, ...currentWork, incumbent });
    if (!policy.approved) throw new Error(`policy changed before reservation: ${policy.reason}`);

    const commandId = randomUUID();
    const orderId = randomUUID();
    const commandKey = `command:decision:${decision.id}`;
    const orderKey = `development:${commandId}`;
    const command = {
      id: commandId,
      idempotencyKey: commandKey,
      decisionId: decision.id,
      expectedPortfolioRevision: currentSettings.portfolioRevision,
      operation: policy.operation,
      productId: pitch.id,
      approvedAt: new Date().toISOString(),
    } as const;
    const order = developmentOrderSchema.parse({
      id: orderId,
      commandId,
      idempotencyKey: orderKey,
      productId: pitch.id,
      pitch,
      createdAt: new Date().toISOString(),
    });

    await client.query(
      `INSERT INTO products(id, slug, name, status, score)
       VALUES ($1, $2, $3, 'RESERVED', $4)`,
      [pitch.id, pitch.slug, pitch.name, decision.score],
    );
    await client.query(
      `INSERT INTO management_commands(
         id, decision_id, idempotency_key, expected_portfolio_revision,
         operation, product_id, status, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', 'policy approved')`,
      [command.id, command.decisionId, command.idempotencyKey, command.expectedPortfolioRevision, command.operation, command.productId],
    );
    await client.query(
      `INSERT INTO development_orders(id, command_id, idempotency_key, product_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [order.id, order.commandId, order.idempotencyKey, order.productId, JSON.stringify(order)],
    );
    await client.query(
      `INSERT INTO jobs(kind, payload, idempotency_key)
       VALUES ('dispatch_development_order', $1::jsonb, $2)`,
      [JSON.stringify({ orderId: order.id }), `manager:dispatch:${order.id}`],
    );
    await client.query(
      "UPDATE factory_settings SET portfolio_revision = portfolio_revision + 1, updated_at = now() WHERE singleton = true",
    );
    await writeAudit(client, "manager-man", "command.approved", command.id, correlationId, {
      operation: command.operation,
      productId: command.productId,
      orderId: order.id,
    });
  }, "SERIALIZABLE");
}

async function dispatchDevelopmentOrder(jobPayload: unknown, correlationId: string): Promise<void> {
  const { orderId } = z.object({ orderId: z.string().uuid() }).parse(jobPayload);
  const result = await database.query<{ payload: unknown; dispatched_at: Date | null }>(
    "SELECT payload, dispatched_at FROM development_orders WHERE id = $1",
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("development order not found");
  if (row.dispatched_at) return;
  const order = developmentOrderSchema.parse(row.payload);
  const repository = await github.createProductRepository(order);
  await withTransaction(database, async (client) => {
    await client.query("UPDATE development_orders SET dispatched_at = now() WHERE id = $1", [orderId]);
    await client.query("UPDATE products SET status = 'BUILDING', updated_at = now() WHERE id = $1", [order.productId]);
    await writeAudit(client, "manager-man", "product-repository.created", orderId, correlationId, {
      repository: repository.fullName,
      issueNumber: repository.issueNumber,
      issueUrl: repository.issueUrl,
    });
  });
}

async function processNextJob(): Promise<boolean> {
  const job = await claimJob(
    database,
    ["evaluate_decision", "dispatch_development_order", "deploy_release"],
    workerId,
    config.JOB_LEASE_SECONDS,
  );
  if (!job) return false;
  try {
    if (job.kind === "deploy_release") {
      const settings = await getFactorySettings(database);
      if (!settings.automationEnabled || settings.emergencyStop) {
        await deferJob(database, job.id, workerId, 60, "deployment blocked by factory settings");
        return true;
      }
      await deployRelease(job.payload, job.id);
    }
    if (job.kind === "evaluate_decision") await evaluateDecisionJob(job.payload, job.id);
    if (job.kind === "dispatch_development_order") await dispatchDevelopmentOrder(job.payload, job.id);
    await completeJob(database, job.id, workerId);
  } catch (error) {
    app.log.error({ err: error, jobId: job.id, kind: job.kind }, "manager job failed");
    await failJob(database, job, workerId, error);
  }
  return true;
}

async function workerLoop(): Promise<void> {
  let nextReleasePoll = 0;
  while (!controller.signal.aborted) {
    if (Date.now() >= nextReleasePoll) {
      nextReleasePoll = Date.now() + config.RELEASE_POLL_INTERVAL_MS;
      await pollReleases().catch((error: unknown) => app.log.warn({ err: error }, "release polling will retry"));
    }
    const processed = await processNextJob();
    if (!processed) await wait(config.POLL_INTERVAL_MS, controller.signal);
  }
}

async function shutdown(): Promise<void> {
  controller.abort();
  await app.close();
  await database.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

if (config.RUN_MIGRATIONS) await migrateDatabase(database);
await app.listen({ host: "0.0.0.0", port: config.PORT });
void workerLoop().catch((error: unknown) => {
  app.log.fatal({ err: error }, "manager worker stopped");
  process.exitCode = 1;
  void shutdown();
});
