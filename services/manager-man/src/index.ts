import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import {
  developmentOrderSchema,
  occupiedProductStates,
  portfolioDecisionSchema,
  productPitchSchema,
  verifiedReleaseSchema,
  type VerifiedRelease,
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

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  RUN_MIGRATIONS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AI_PIPES_BASE_URL: z.string().url(),
  AI_PIPES_API_TOKEN: z.string().min(16),
  AI_PIPES_WEBHOOK_TOKEN: z.string().min(32),
  GITHUB_TOKEN: z.string().min(20),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_HELM_REPOSITORY: z.string().min(1).default("homelab-helm"),
  GITHUB_GITOPS_REPOSITORY: z.string().min(1).default("homelab-gitops"),
  GITHUB_TARGET_BRANCH: z.string().min(1).default("main"),
  REGISTRY_EVIDENCE_ALLOWED_HOSTS: z.string().min(1),
  REGISTRY_BEARER_TOKEN: z.string().min(1).optional(),
  ARGOCD_BASE_URL: z.string().url(),
  ARGOCD_AUTH_TOKEN: z.string().min(1),
  PRODUCT_BASE_DOMAIN: z.string().min(1).default("ai-products.gurkeschale.ch"),
});

const config = configSchema.parse(process.env);
const app = Fastify({ logger: { level: config.LOG_LEVEL, name: "manager-man" } });
const database = createDatabase(config.DATABASE_URL, "manager-man");
const workerId = `manager-man:${hostname()}:${process.pid}`;
const controller = new AbortController();
const github = new GitHubWriter({
  token: config.GITHUB_TOKEN,
  owner: config.GITHUB_OWNER,
  helmRepository: config.GITHUB_HELM_REPOSITORY,
  gitopsRepository: config.GITHUB_GITOPS_REPOSITORY,
  branch: config.GITHUB_TARGET_BRANCH,
});
const registryHosts = new Set(config.REGISTRY_EVIDENCE_ALLOWED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean));

function secretsEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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

app.post<{ Body: unknown }>("/v1/releases", async (request, reply) => {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!secretsEqual(token, config.AI_PIPES_WEBHOOK_TOKEN)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const release = verifiedReleaseSchema.parse(request.body);
  const order = await database.query<{ product_id: string }>(
    "SELECT product_id FROM development_orders WHERE id = $1",
    [release.orderId],
  );
  if (!order.rows[0] || order.rows[0].product_id !== release.productId) {
    return reply.code(409).send({ error: "release does not match a known development order" });
  }

  await withTransaction(database, async (client) => {
    const existing = await client.query<{ payload: unknown }>(
      "SELECT payload FROM verified_releases WHERE order_id = $1 FOR UPDATE",
      [release.orderId],
    );
    if (existing.rows[0]) {
      const previous = verifiedReleaseSchema.parse(existing.rows[0].payload);
      if (JSON.stringify(previous) !== JSON.stringify(release)) {
        throw new Error("idempotency conflict for verified release");
      }
      return;
    }
    await client.query(
      "INSERT INTO verified_releases(order_id, product_id, payload) VALUES ($1, $2, $3::jsonb)",
      [release.orderId, release.productId, JSON.stringify(release)],
    );
    await client.query(
      `INSERT INTO jobs(kind, payload, idempotency_key)
       VALUES ('deploy_release', $1::jsonb, $2)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [JSON.stringify({ orderId: release.orderId }), `manager:release:${release.orderId}`],
    );
    await writeAudit(client, "manager-man", "release.received", release.orderId, release.productId, {
      sourceCommit: release.sourceCommit,
      imageDigest: release.imageDigest,
    });
  });
  return reply.code(202).send({ status: "accepted" });
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
      maxRounds: 3,
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
  const response = await fetch(new URL("/v1/development-orders", config.AI_PIPES_BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.AI_PIPES_API_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": order.idempotencyKey,
    },
    body: JSON.stringify(order),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`ai-pipes returned ${response.status}`);
  await withTransaction(database, async (client) => {
    await client.query("UPDATE development_orders SET dispatched_at = now() WHERE id = $1", [orderId]);
    await client.query("UPDATE products SET status = 'BUILDING', updated_at = now() WHERE id = $1", [order.productId]);
    await writeAudit(client, "manager-man", "development-order.dispatched", orderId, correlationId);
  });
}

async function verifyRegistryEvidence(release: VerifiedRelease): Promise<void> {
  const url = new URL(release.registryEvidenceUrl);
  if (url.protocol !== "https:" || !registryHosts.has(url.hostname)) {
    throw new Error("registry evidence host is not allowed");
  }
  const headers: Record<string, string> = {};
  if (config.REGISTRY_BEARER_TOKEN) headers.Authorization = `Bearer ${config.REGISTRY_BEARER_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`registry evidence returned ${response.status}`);
  const evidence = await response.text();
  if (!evidence.includes(release.imageDigest)) {
    throw new Error("registry evidence does not contain the expected image digest");
  }
}

async function deploymentIsHealthy(slug: string): Promise<boolean> {
  const appName = `ai-product-${slug}`;
  const response = await fetch(new URL(`/api/v1/applications/${appName}`, config.ARGOCD_BASE_URL), {
    headers: { Authorization: `Bearer ${config.ARGOCD_AUTH_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return false;
  const body = await response.json() as { status?: { sync?: { status?: string }; health?: { status?: string } } };
  if (body.status?.sync?.status !== "Synced" || body.status.health?.status !== "Healthy") return false;
  const health = await fetch(`https://${slug}.${config.PRODUCT_BASE_DOMAIN}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return health.ok;
}

async function deployRelease(jobPayload: unknown, correlationId: string): Promise<"completed" | "deferred"> {
  const { orderId } = z.object({ orderId: z.string().uuid() }).parse(jobPayload);
  const result = await database.query<{
    release: unknown;
    slug: string;
    command_id: string;
    status: string;
  }>(
    `SELECT release.payload AS release, product.slug, orders.command_id, product.status
     FROM verified_releases release
     JOIN development_orders orders ON orders.id = release.order_id
     JOIN products product ON product.id = release.product_id
     WHERE release.order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("verified release not found");
  if (row.status === "LIVE") return "completed";
  const release = verifiedReleaseSchema.parse(row.release);

  await github.verifyCommit(release.sourceRepository, release.sourceCommit);
  await verifyRegistryEvidence(release);
  await github.publishProductConfiguration({
    slug: row.slug,
    imageRepository: release.imageRepository,
    imageDigest: release.imageDigest,
    correlationId,
  });
  await database.query("UPDATE products SET status = 'DEPLOYING', updated_at = now() WHERE id = $1", [release.productId]);

  if (!await deploymentIsHealthy(row.slug)) return "deferred";
  await withTransaction(database, async (client) => {
    await client.query("SELECT singleton FROM factory_settings WHERE singleton = true FOR UPDATE");
    await client.query("UPDATE products SET status = 'LIVE', updated_at = now() WHERE id = $1", [release.productId]);
    await client.query(
      "UPDATE management_commands SET status = 'COMPLETED', reason = 'release verified and live', updated_at = now() WHERE id = $1",
      [row.command_id],
    );
    await client.query(
      "UPDATE factory_settings SET portfolio_revision = portfolio_revision + 1, updated_at = now() WHERE singleton = true",
    );
    await writeAudit(client, "manager-man", "release.published", orderId, correlationId, {
      productId: release.productId,
      sourceCommit: release.sourceCommit,
      imageDigest: release.imageDigest,
    });
  }, "SERIALIZABLE");
  return "completed";
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
    if (job.kind === "evaluate_decision") await evaluateDecisionJob(job.payload, job.id);
    if (job.kind === "dispatch_development_order") await dispatchDevelopmentOrder(job.payload, job.id);
    if (job.kind === "deploy_release") {
      const result = await deployRelease(job.payload, job.id);
      if (result === "deferred") {
        await deferJob(database, job.id, workerId, 30, "waiting for Argo and external health");
        return true;
      }
    }
    await completeJob(database, job.id, workerId);
  } catch (error) {
    app.log.error({ err: error, jobId: job.id, kind: job.kind }, "manager job failed");
    await failJob(database, job, workerId, error);
  }
  return true;
}

async function workerLoop(): Promise<void> {
  while (!controller.signal.aborted) {
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
