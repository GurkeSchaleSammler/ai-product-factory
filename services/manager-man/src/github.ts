import type { DevelopmentOrder, ProductPitch } from "@factory/contracts";
import sodium from "libsodium-wrappers";

export interface GitHubConfig {
  token: string;
  owner: string;
  helmRepository: string;
  gitopsRepository: string;
  branch: string;
  productOwner: string;
  pipelineOwner: string | undefined;
  pipelineRepository: string;
  pipelineBranch: string;
  productRepositoriesPrivate: boolean;
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
          private: this.#config.productRepositoriesPrivate,
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

    await this.#setActionsEnabled(repository.full_name, false);
    if (!await this.#branchExists(repository.full_name, "main")) {
      await this.#copyPipelineBranch(repository.full_name, actor.login);
    }
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
      body: JSON.stringify({ enabled, allowed_actions: "all" }),
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
      `## Evidence\n\n${evidence}`;
  }

  #repoPath(repository: string): string {
    return repository.split("/").map((part) => this.#segment(part)).join("/");
  }

  #segment(value: string): string {
    return encodeURIComponent(value);
  }

  async verifyCommit(repository: string, commit: string): Promise<void> {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra || owner !== this.#config.owner) {
      throw new Error("source repository is outside the configured GitHub owner");
    }
    await this.#request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}`);
    const checks = await this.#request<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}/check-runs`,
    );
    if (checks.total_count < 1 || checks.check_runs.some((check) => check.status !== "completed" || check.conclusion !== "success")) {
      throw new Error("GitHub checks are missing or not successful");
    }
    const pulls = await this.#request<Array<{ number: number; merged_at: string | null }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit}/pulls`,
    );
    const merged = pulls.find((pull) => pull.merged_at !== null);
    if (!merged) throw new Error("source commit is not associated with a merged pull request");
    const reviews = await this.#request<Array<{ state: string }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${merged.number}/reviews`,
    );
    if (!reviews.some((review) => review.state === "APPROVED")) {
      throw new Error("merged pull request has no approved review");
    }
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

  async #request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#config.token}`,
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
