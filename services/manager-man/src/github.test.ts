import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubWriter, type GitHubConfig } from "./github.js";

const productId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GitHubWriter.createProductRepository", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("configures the product repo and creates one pitch issue", async () => {
    await sodium.ready;
    const publicKey = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url.endsWith("/user")) return json({ login: "manager-account" });
      if (url.endsWith("/repos/manager-account/test-product")) {
        return json({
          name: "test-product",
          full_name: "manager-account/test-product",
          description: `AI Product Factory product ${productId}`,
          owner: { login: "manager-account" },
        });
      }
      if (url.endsWith("/branches/main")) return json({ name: "main" });
      if (url.endsWith("/actions/secrets/public-key")) return json({ key_id: "key-1", key: publicKey });
      if (url.includes("/actions/secrets/")) return new Response(null, { status: 204 });
      if (url.endsWith("/actions/permissions")) return new Response(null, { status: 204 });
      if (url.endsWith("/labels/scope-override")) return json({ message: "Not Found" }, 404);
      if (url.endsWith("/labels")) return json({ name: "scope-override" }, 201);
      if (url.endsWith("/issues?state=all&per_page=100")) return json([]);
      if (url.endsWith("/issues") && method === "POST") {
        return json({ number: 1, html_url: "https://github.com/manager-account/test-product/issues/1" }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }));

    const config: GitHubConfig = {
      token: "github-token-value",
      owner: "infra-owner",
      helmRepository: "homelab-helm",
      gitopsRepository: "homelab-gitops",
      branch: "main",
      productOwner: "manager-account",
      pipelineOwner: undefined,
      pipelineRepository: "empty-produkt",
      pipelineBranch: "main",
      productRepositoriesPrivate: true,
      productSecrets: { TAMBINOS_PAT: "github-token-value", DEEPSEEK_API_KEY: "deepseek-key" },
    };
    const result = await new GitHubWriter(config).createProductRepository({
      id: orderId,
      commandId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "development:33333333-3333-4333-8333-333333333333",
      productId,
      createdAt: "2026-10-14T18:00:00.000Z",
      pitch: {
        id: productId,
        windowId: "2026101418",
        slug: "test-product",
        name: "Test Product",
        targetAudience: "Small teams",
        problem: "Manual work",
        valueProposition: "Automates the work",
        scope: ["Import data", "Create reports"],
        differentiation: "Simple setup",
        revenueHypothesis: "Monthly subscription",
        risks: ["Adoption"],
        validationPlan: "Interview five teams",
        evidence: [{
          id: "evidence-1",
          title: "Research",
          url: "https://example.com/research",
          summary: "Teams report the problem",
          independentGroup: "example",
        }],
      },
    });

    expect(result).toEqual({
      fullName: "manager-account/test-product",
      issueNumber: 1,
      issueUrl: "https://github.com/manager-account/test-product/issues/1",
    });
    const issueRequest = requests.find((request) => request.url.endsWith("/issues") && request.method === "POST");
    expect(issueRequest?.body).toMatchObject({
      title: "Begin Test Product",
      assignees: ["manager-account"],
      labels: ["scope-override"],
    });
    expect(issueRequest?.body?.body).toContain("## Validation plan\n\nInterview five teams");
    expect(issueRequest?.body?.body).toContain(`<!-- factory-development-order:${orderId} -->`);
    expect(requests.filter((request) => /\/actions\/secrets\/(TAMBINOS_PAT|DEEPSEEK_API_KEY)$/.test(request.url)).length).toBe(2);
    const actionsRequests = requests.filter((request) => request.url.endsWith("/actions/permissions"));
    expect(actionsRequests.map((request) => request.body)).toEqual([
      { enabled: false },
      { enabled: true, allowed_actions: "all" },
    ]);
  });
});
