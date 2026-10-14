interface GitHubConfig {
  token: string;
  owner: string;
  helmRepository: string;
  gitopsRepository: string;
  branch: string;
}

interface GitHubFile {
  sha: string;
  content: string;
  encoding: string;
}

export class GitHubWriter {
  readonly #config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.#config = config;
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
