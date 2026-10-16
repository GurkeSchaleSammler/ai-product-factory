import type { DevelopmentOrder, ProductPitch } from "@factory/contracts";
import sodium from "libsodium-wrappers";
import { readFile } from "node:fs/promises";

export interface GitHubConfig {
  token: string;
  infraToken?: string | undefined;
  owner: string;
  helmRepository: string;
  gitopsRepository: string;
  branch: string;
  productOwner: string;
  pipelineOwner: string | undefined;
  pipelineRepository: string;
  pipelineBranch: string;
  productSecrets: Record<string, string>;
}

interface GitHubFile {
  sha: string;
  content: string;
  encoding: string;
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface GitHubRepository {
  name: string;
  full_name: string;
  description: string | null;
  private?: boolean;
  owner: { login: string };
}

export interface ProductRepositoryResult {
  fullName: string;
  issueNumber: number;
  issueUrl: string;
}

export class GitHubWriter {
  readonly #config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.#config = config;
  }

  async createProductRepository(order: DevelopmentOrder): Promise<ProductRepositoryResult> {
    const actor = await this.#request<{ login: string }>("/user");
    if (actor.login.toLowerCase() !== this.#config.productOwner.toLowerCase()) {
      throw new Error(`GitHub token belongs to ${actor.login}; expected product owner ${this.#config.productOwner}`);
    }
    const repositoryName = order.pitch.slug;
    const fullName = `${actor.login}/${repositoryName}`;
    const description = `AI Product Factory product ${order.productId}`;
    let repository: GitHubRepository;
    try {
      repository = await this.#request<GitHubRepository>(`/repos/${this.#segment(actor.login)}/${this.#segment(repositoryName)}`);
      if (repository.description !== description) {
        throw new Error(`repository ${fullName} already exists and is not owned by this development order`);
      }
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
      repository = await this.#request<GitHubRepository>("/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name: repositoryName,
          description,
          private: false,
          auto_init: false,
          has_issues: true,
          has_projects: false,
          has_wiki: false,
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
          delete_branch_on_merge: true,
        }),
      });
    }

    if (repository.private) await this.#publishRepository(repository.full_name);
    await this.#setActionsEnabled(repository.full_name, false);
    if (!await this.#branchExists(repository.full_name, "main")) {
      await this.#copyPipelineBranch(repository.full_name, actor.login);
    }
    await this.ensureReleaseWorkflow(repository.full_name);
    await this.ensureProductLicense(repository.full_name, actor.login);
    await Promise.all(Object.entries(this.#config.productSecrets).map(([name, value]) =>
      this.#putActionsSecret(repository.full_name, name, value)));
    await this.#setActionsEnabled(repository.full_name, true);
    await this.#ensureScopeOverrideLabel(repository.full_name);

    const marker = `<!-- factory-development-order:${order.id} -->`;
    const issues = await this.#request<Array<{ number: number; html_url: string; body: string | null }>>(
      `/repos/${this.#repoPath(repository.full_name)}/issues?state=all&per_page=100`,
    );
    const existing = issues.find((issue) => issue.body?.includes(marker));
    if (existing) return { fullName: repository.full_name, issueNumber: existing.number, issueUrl: existing.html_url };

    const issue = await this.#request<{ number: number; html_url: string }>(
      `/repos/${this.#repoPath(repository.full_name)}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Begin ${order.pitch.name}`,
          body: `${this.#formatPitch(order.pitch)}\n\n${marker}\n`,
          assignees: [repository.owner.login],
          labels: ["scope-override"],
        }),
      },
    );
    return { fullName: repository.full_name, issueNumber: issue.number, issueUrl: issue.html_url };
  }

  async publishExistingProductRepositories(): Promise<string[]> {
    const published: string[] = [];
    for (let page = 1; ; page += 1) {
      const repositories = await this.#request<GitHubRepository[]>(
        `/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`,
      );
      for (const repository of repositories) {
        if (repository.owner.login.toLowerCase() !== this.#config.productOwner.toLowerCase()
          || !/^AI Product Factory product [0-9a-f-]{36}$/i.test(repository.description ?? "")) continue;
        if (repository.private) {
          await this.#publishRepository(repository.full_name);
          published.push(repository.full_name);
        }
        await this.ensureProductLicense(repository.full_name, repository.owner.login);
      }
      if (repositories.length < 100) return published;
    }
  }

  async #publishRepository(repository: string): Promise<void> {
    await this.#request(`/repos/${this.#repoPath(repository)}`, {
      method: "PATCH",
      body: JSON.stringify({ private: false }),
    });
  }

  async ensureProductLicense(repository: string, owner: string): Promise<void> {
    for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"]) {
      try {
        await this.#request(`/repos/${this.#repoPath(repository)}/contents/${filename}`);
        return;
      } catch (error) {
        if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
      }
    }
    const content = `MIT License

Copyright (c) ${new Date().getUTCFullYear()} ${owner}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
    await this.#request(`/repos/${this.#repoPath(repository)}/contents/LICENSE`, {
      method: "PUT",
      body: JSON.stringify({
        message: "docs: license product under MIT", branch: "main",
        content: Buffer.from(content).toString("base64"),
      }),
    });
  }

  async ensureReleaseWorkflow(repository: string): Promise<void> {
    const path = `/repos/${this.#repoPath(repository)}/contents/.github/workflows/factory-release.yml`;
    try {
      await this.#request(path);
      return;
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
    }
    const content = await readFile(new URL("../assets/factory-release.yml", import.meta.url), "utf8");
    await this.#request(path, { method: "PUT", body: JSON.stringify({
      message: "ci: add reviewed multi-architecture factory releases", branch: "main",
      content: Buffer.from(content).toString("base64"),
    }) });
  }

  async #copyPipelineBranch(destination: string, authenticatedOwner: string): Promise<void> {
    const source = `${this.#config.pipelineOwner ?? authenticatedOwner}/${this.#config.pipelineRepository}`;
    const reference = await this.#request<{ object: { sha: string } }>(
      `/repos/${this.#repoPath(source)}/git/ref/heads/${this.#segment(this.#config.pipelineBranch)}`,
    );
    const commit = await this.#request<{ tree: { sha: string } }>(
      `/repos/${this.#repoPath(source)}/git/commits/${reference.object.sha}`,
    );
    const sourceTree = await this.#request<{ tree: GitTreeEntry[]; truncated: boolean }>(
      `/repos/${this.#repoPath(source)}/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (sourceTree.truncated) throw new Error("ai-pipes template tree was truncated by GitHub");
    if (sourceTree.tree.some((entry) => entry.type === "commit")) {
      throw new Error("ai-pipes template contains unsupported Git submodules");
    }
    const blobs = sourceTree.tree.filter((entry) => entry.type === "blob").sort((left, right) => left.path.localeCompare(right.path));
    for (const [index, entry] of blobs.entries()) {
      const blob = await this.#request<{ content: string; encoding: string }>(
        `/repos/${this.#repoPath(source)}/git/blobs/${entry.sha}`,
      );
      if (blob.encoding !== "base64") throw new Error(`unsupported GitHub blob encoding for ${entry.path}`);
      await this.#request(`/repos/${this.#repoPath(destination)}/contents/${entry.path.split("/").map((part) => this.#segment(part)).join("/")}`, {
        method: "PUT",
        body: JSON.stringify({
          message: index === 0 ? "chore: initialize AI development pipeline" : `chore: add pipeline file ${entry.path}`,
          content: blob.content.replace(/\s/g, ""),
          branch: "main",
        }),
      });
    }
    await this.#request(`/repos/${this.#repoPath(destination)}`, {
      method: "PATCH",
      body: JSON.stringify({ default_branch: "main" }),
    });
  }

  async #branchExists(repository: string, branch: string): Promise<boolean> {
    try {
      await this.#request(`/repos/${this.#repoPath(repository)}/branches/${this.#segment(branch)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return false;
      throw error;
    }
  }

  async #putActionsSecret(repository: string, name: string, value: string): Promise<void> {
    const key = await this.#request<{ key_id: string; key: string }>(
      `/repos/${this.#repoPath(repository)}/actions/secrets/public-key`,
    );
    await sodium.ready;
    const encryptedValue = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)),
      sodium.base64_variants.ORIGINAL,
    );
    await this.#request(`/repos/${this.#repoPath(repository)}/actions/secrets/${this.#segment(name)}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: key.key_id }),
    });
  }

  async #setActionsEnabled(repository: string, enabled: boolean): Promise<void> {
    await this.#request(`/repos/${this.#repoPath(repository)}/actions/permissions`, {
      method: "PUT",
      body: JSON.stringify(enabled ? { enabled: true, allowed_actions: "all" } : { enabled: false }),
    });
  }

  async #ensureScopeOverrideLabel(repository: string): Promise<void> {
    try {
      await this.#request(`/repos/${this.#repoPath(repository)}/labels/scope-override`);
      return;
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
    }
    await this.#request(`/repos/${this.#repoPath(repository)}/labels`, {
      method: "POST",
      body: JSON.stringify({
        name: "scope-override",
        color: "5319E7",
        description: "AI implementation may edit any repository file",
      }),
    });
  }

  #formatPitch(pitch: ProductPitch): string {
    const bullets = (values: string[]) => values.map((value) => `- ${value}`).join("\n");
    const evidence = pitch.evidence.length === 0
      ? "- No external evidence supplied."
      : pitch.evidence.map((item) => `- [${item.title}](${item.url}) — ${item.summary} (${item.independentGroup}; ID: ${item.id})`).join("\n");
    return `# Product pitch\n\n` +
      `**Pitch ID:** ${pitch.id}\n\n` +
      `**Window ID:** ${pitch.windowId}\n\n` +
      `**Name:** ${pitch.name}\n\n` +
      `**Slug:** ${pitch.slug}\n\n` +
      `## Target audience\n\n${pitch.targetAudience}\n\n` +
      `## Problem\n\n${pitch.problem}\n\n` +
      `## Value proposition\n\n${pitch.valueProposition}\n\n` +
      `## Scope\n\n${bullets(pitch.scope)}\n\n` +
      `## Differentiation\n\n${pitch.differentiation}\n\n` +
      `## Revenue hypothesis\n\n${pitch.revenueHypothesis}\n\n` +
      `## Risks\n\n${bullets(pitch.risks)}\n\n` +
      `## Validation plan\n\n${pitch.validationPlan}\n\n` +
      `## Evidence\n\n${evidence}\n\n` +
      `## Factory deployment contract\n\n` +
      `Deliver a runnable Dockerfile (linux/amd64 and linux/arm64) exposing HTTP on port 8080, with GET /healthz. ` +
      `Include exactly one complete Helm chart under deploy/helm/<chart-name>/. ` +
      `Use image.repository and image.digest to render repository@digest; configure ingress via ingress.enabled, ingress.host and ingress.className. ` +
      `Include resource requests/limits, non-root execution and persistent storage where required. ` +
      `Keep .github/workflows/factory-release.yml: it builds reviewed merges and publishes the image manifest. ` +
      `The Factory manager publishes the chart to the infrastructure repositories; product workflows do not receive infrastructure credentials.`;
  }

  #repoPath(repository: string): string {
    return repository.split("/").map((part) => this.#segment(part)).join("/");
  }

  #segment(value: string): string {
    return encodeURIComponent(value);
  }

  async verifyCommit(repository: string, commit: string): Promise<void> {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra || owner !== this.#config.productOwner) {
      throw new Error("source repository is outside the configured GitHub owner");
    }
    await this.#request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}`);
    const checks = await this.#request<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}/check-runs`,
    );
    const ci = checks.check_runs.filter((check) => check.name.startsWith("test"));
    if (ci.length < 1 || ci.some((check) => check.status !== "completed" || check.conclusion !== "success")) {
      throw new Error("GitHub checks are missing or not successful");
    }
    const pulls = await this.#request<Array<{ number: number; merged_at: string | null; merge_commit_sha: string; head: { sha: string } }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}/pulls`,
    );
    const merged = pulls.find((pull) => pull.merged_at !== null && pull.merge_commit_sha === commit);
    if (!merged) throw new Error("source commit is not associated with a merged pull request");
    const reviews = await this.#request<Array<{ state: string; body: string; commit_id: string; user: { login: string } }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${merged.number}/reviews`,
    );
    const latest = reviews.filter((review) => review.commit_id === merged.head.sha &&
      review.user.login.toLowerCase() === this.#config.productOwner.toLowerCase()).at(-1);
    if (!latest || !(latest.state === "APPROVED" || (latest.state === "COMMENTED" &&
      latest.body.trimStart().startsWith("REVIEW_VERDICT: APPROVED\n") && latest.body.includes("<!-- ai-pipes-review -->")))) {
      throw new Error("merged pull request has no approved review");
    }
  }

  async productRequest<T>(repository: string, path: string): Promise<T> {
    if (repository.split("/")[0]?.toLowerCase() !== this.#config.productOwner.toLowerCase()) {
      throw new Error("product repository owner mismatch");
    }
    return this.#request<T>(`/repos/${this.#repoPath(repository)}${path}`);
  }

  async publishFiles(repository: string, files: Record<string, string>, correlationId: string): Promise<string> {
    const token = this.#config.infraToken;
    if (!token) throw new Error("GITHUB_INFRA_TOKEN is required for deployment");
    const actor = await this.#request<{ login: string; id: number }>("/user", {}, token);
    if (actor.login.toLowerCase() !== this.#config.owner.toLowerCase()) throw new Error("infrastructure token owner mismatch");
    if (![this.#config.helmRepository, this.#config.gitopsRepository].includes(repository)) throw new Error("infrastructure repository not allowed");
    const allowedPrefix = repository === this.#config.helmRepository ? "charts/ai-products/" : "applications/ai-products/";
    if (Object.keys(files).some((path) => !path.startsWith(allowedPrefix) || path.includes(".."))) throw new Error("infrastructure path not allowed");
    const root = `/repos/${this.#segment(this.#config.owner)}/${this.#segment(repository)}`;
    const request = <T>(path: string, method = "GET", body?: unknown) => this.#request<T>(root + path,
      { method, ...(body ? { body: JSON.stringify(body) } : {}) }, token);
    const ref = await request<{ object: { sha: string } }>(`/git/ref/heads/${this.#segment(this.#config.branch)}`);
    const parent = await request<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);
    const tree = await request<{ sha: string }>("/git/trees", "POST", {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    });
    if (tree.sha === parent.tree.sha) return ref.object.sha;
    const commit = await request<{ sha: string }>("/git/commits", "POST", {
      message: `factory(${correlationId}): publish product deployment`, tree: tree.sha, parents: [ref.object.sha],
      author: { name: actor.login, email: `${actor.id}+${actor.login}@users.noreply.github.com` },
    });
    await request(`/git/refs/heads/${this.#segment(this.#config.branch)}`, "PATCH", { sha: commit.sha, force: false });
    return commit.sha;
  }

  async publishProductConfiguration(input: {
    slug: string;
    imageRepository: string;
    imageDigest: string;
    correlationId: string;
  }): Promise<void> {
    const valuesPath = `charts/ai-products/${input.slug}/values-factory.yaml`;
    const values = `image:\n  repository: ${JSON.stringify(input.imageRepository)}\n  digest: ${JSON.stringify(input.imageDigest)}\n`;
    await this.#putFile(this.#config.helmRepository, valuesPath, values, input.correlationId);

    const applicationPath = `applications/ai-products/${input.slug}.yaml`;
    const application = `apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: ai-product-${input.slug}\n  namespace: argocd\nspec:\n  project: default\n  source:\n    repoURL: https://github.com/${this.#config.owner}/${this.#config.helmRepository}.git\n    targetRevision: ${this.#config.branch}\n    path: charts/ai-products/${input.slug}\n    helm:\n      valueFiles:\n        - values-factory.yaml\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: ai-product-${input.slug}\n  syncPolicy:\n    automated:\n      prune: true\n      selfHeal: true\n    syncOptions:\n      - CreateNamespace=true\n`;
    await this.#putFile(this.#config.gitopsRepository, applicationPath, application, input.correlationId);
  }

  async #putFile(repository: string, path: string, content: string, correlationId: string): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(this.#config.owner)}/${encodeURIComponent(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    let current: GitHubFile | null = null;
    try {
      current = await this.#request<GitHubFile>(`${endpoint}?ref=${encodeURIComponent(this.#config.branch)}`);
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
    }
    if (current?.encoding === "base64") {
      const normalized = current.content.replace(/\s/g, "");
      if (Buffer.from(normalized, "base64").toString("utf8") === content) return;
    }
    await this.#request(endpoint, {
      method: "PUT",
      body: JSON.stringify({
        message: `factory(${correlationId}): deploy ${path}`,
        content: Buffer.from(content).toString("base64"),
        branch: this.#config.branch,
        ...(current ? { sha: current.sha } : {}),
      }),
    });
  }

  async #request<T = unknown>(path: string, init: RequestInit = {}, token = this.#config.token): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new GitHubHttpError(response.status, `GitHub API returned ${response.status}`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
}

class GitHubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
