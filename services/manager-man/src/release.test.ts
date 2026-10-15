import { describe, expect, it, vi } from "vitest";
import { adaptChartFile, publishRelease, validateRelease } from "./release.js";
import type { GitHubWriter } from "./github.js";

const repository = "sechssiebe67-wq/pilot";
const release = {
  sourceRepository: repository, sourceCommit: "a".repeat(40),
  imageRepository: `ghcr.io/${repository}`, imageDigest: `sha256:${"b".repeat(64)}`,
  chartPath: "deploy/helm/pilot",
};

describe("product release", () => {
  it("rejects images or chart paths outside the product", () => {
    expect(() => validateRelease({ ...release, imageRepository: "ghcr.io/other/pilot" }, repository)).toThrow();
    expect(() => validateRelease({ ...release, chartPath: "deploy/helm/../../other" }, repository)).toThrow();
  });

  it("pins deployment images and injects the namespace pull credential", () => {
    const result = adaptChartFile("templates/deployment.yaml", `kind: Deployment
spec:
  template:
    spec:
      containers:
        - image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`, "pilot");
    expect(result).toContain('image: "{{ .Values.image.repository }}@{{ .Values.image.digest }}"');
    expect(result).toContain("imagePullSecrets:\n        - name: ghcr-product-images");
    expect(() => adaptChartFile("deployment.yaml", "kind: Deployment\nimage: arbitrary:latest", "pilot")).toThrow();
  });

  it("publishes the complete chart before the pinned Argo application", async () => {
    const files = { "Chart.yaml": "name: pilot\nversion: 0.1.0\n", "values.yaml": "image: {}\n" };
    const publishFiles = vi.fn().mockResolvedValueOnce("c".repeat(40)).mockResolvedValueOnce("d".repeat(40));
    const github = {
      productRequest: vi.fn(async (_repo: string, path: string) => path.includes("trees/") ? {
        truncated: false, tree: Object.keys(files).map((name) => ({
          path: `${release.chartPath}/${name}`, type: "blob", mode: "100644", sha: name,
        })),
      } : { content: Buffer.from(files[path.split("/").at(-1) as keyof typeof files]).toString("base64") }),
      publishFiles,
    } as unknown as GitHubWriter;
    const sha = await publishRelease(github, release, "pilot", "homelab-helm", "homelab-gitops", "GurkeSchaleSammler", "test");
    expect(sha).toBe("c".repeat(40));
    const chart = publishFiles.mock.calls[0]?.[1] as Record<string, string>;
    expect(chart["charts/ai-products/pilot/Chart.yaml"]).toBe(files["Chart.yaml"]);
    expect(chart["charts/ai-products/pilot/values-factory.yaml"]).toContain(release.imageDigest);
    const application = publishFiles.mock.calls[1]?.[1] as Record<string, string>;
    expect(application["applications/ai-products/pilot.yaml"]).toContain(`targetRevision: ${sha}`);
    expect(application["applications/ai-products/pilot.yaml"]).toContain("namespace: ai-product-pilot");
  });
});
