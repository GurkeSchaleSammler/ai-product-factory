import { z } from "zod";
import { GitHubWriter } from "./github.js";

export const releaseSchema = z.object({
  sourceRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  imageRepository: z.string().regex(/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  chartPath: z.string().regex(/^deploy\/helm\/[a-z0-9-]+$/),
});
export type ProductRelease = z.infer<typeof releaseSchema>;

export function validateRelease(value: unknown, repository: string): ProductRelease {
  const release = releaseSchema.parse(value);
  if (release.sourceRepository !== repository || release.imageRepository !== `ghcr.io/${repository.toLowerCase()}`) {
    throw new Error("release repository identity mismatch");
  }
  return release;
}

export async function discoverRelease(github: GitHubWriter, repository: string): Promise<ProductRelease | null> {
  const releases = await github.productRequest<Array<{ tag_name: string; draft: boolean; prerelease: boolean; body: string }>>(
    repository, "/releases?per_page=20");
  const latest = releases.find((release) => !release.draft && !release.prerelease && release.tag_name.startsWith("factory-"));
  if (!latest) return null;
  const release = validateRelease(JSON.parse(latest.body), repository);
  if (latest.tag_name !== `factory-${release.sourceCommit}`) throw new Error("release tag does not match source commit");
  return release;
}

export async function verifyImage(release: ProductRelease, token: string): Promise<void> {
  const image = release.imageRepository.slice("ghcr.io/".length);
  const auth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`, {
    headers: { Authorization: `Basic ${Buffer.from(`${release.sourceRepository.split("/")[0]}:${token}`).toString("base64")}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!auth.ok) throw new Error(`registry auth failed: ${auth.status}`);
  const credential = await auth.json() as { token: string };
  const headers = { Authorization: `Bearer ${credential.token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" };
  const get = async (path: string) => {
    const response = await fetch(`https://ghcr.io/v2/${image}/${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`registry verification failed: ${response.status}`);
    return response.json();
  };
  const index = await get(`manifests/${release.imageDigest}`) as { manifests?: Array<{ digest: string; platform?: { os: string; architecture: string } }> };
  const arm = index.manifests?.find((manifest) => manifest.platform?.os === "linux" && manifest.platform.architecture === "arm64");
  if (!arm) throw new Error("release image has no linux/arm64 manifest");
  const manifest = await get(`manifests/${arm.digest}`) as { config: { digest: string } };
  const config = await get(`blobs/${manifest.config.digest}`) as { config?: { Labels?: Record<string, string> } };
  if (config.config?.Labels?.["org.opencontainers.image.revision"] !== release.sourceCommit ||
    config.config.Labels["org.opencontainers.image.source"] !== `https://github.com/${release.sourceRepository}`) {
    throw new Error("image provenance labels do not match reviewed source");
  }
}

export function adaptChartFile(path: string, content: string, slug: string, domain = "gurkeschale.ch"): string {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    content = content.replace(/\.Values\.image\.repository\s*}}:\s*{{\s*\.Values\.image\.tag/g,
      ".Values.image.repository }}@{{ .Values.image.digest");
    if (/kind:\s*(Deployment|StatefulSet|PersistentVolumeClaim)/.test(content)) {
      content = content.replace(/(metadata:\r?\n)/, '$1  annotations:\n    argocd.argoproj.io/sync-wave: "2"\n');
    }
    if (/kind:\s*(Deployment|StatefulSet)/.test(content)) {
      if (!content.includes(".Values.image.digest")) throw new Error(`chart must support image.digest: ${path}`);
      if (!content.includes("imagePullSecrets:")) content = content.replace(/(    spec:\r?\n)/,
        "$1      automountServiceAccountToken: false\n      imagePullSecrets:\n        - name: ghcr-product-images\n");
    }
    if (/kind:\s*Ingress\s/.test(content)) {
      content = content.replace(/(metadata:\r?\n)/, '$1  annotations:\n    cert-manager.io/cluster-issuer: letsencrypt-cloudflare\n');
      content = content.replace(/(\nspec:\r?\n)/, `$1  tls:\n    - hosts: [${slug}.${domain}]\n      secretName: ${slug}-tls\n`);
    }
  }
  return content;
}

// The sync hook receives only permission to read the designated source credential
// and to create/patch the pull secret in this product's own namespace.
export function pullSecretHook(slug: string): string {
  const ns = `ai-product-${slug}`;
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: factory-registry-bootstrap
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: factory-registry-reader-${slug}
  namespace: ai-product-factory
rules:
  - apiGroups: [""]
    resources: [secrets]
    resourceNames: [ghcr-product-images]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: factory-registry-reader-${slug}
  namespace: ai-product-factory
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: factory-registry-reader-${slug}
subjects:
  - kind: ServiceAccount
    name: factory-registry-bootstrap
    namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: factory-registry-writer
rules:
  - apiGroups: [""]
    resources: [secrets]
    verbs: [get, create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: factory-registry-writer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: factory-registry-writer
subjects:
  - kind: ServiceAccount
    name: factory-registry-bootstrap
    namespace: ${ns}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: factory-registry-bootstrap
  annotations:
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/sync-wave: "1"
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation,HookSucceeded
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 180
  template:
    spec:
      serviceAccountName: factory-registry-bootstrap
      restartPolicy: Never
      containers:
        - name: copy
          image: alpine/k8s:1.34.1
          command: [sh, -ec]
          args:
            - |
              credential=$(kubectl -n ai-product-factory get secret ghcr-product-images -o jsonpath='{.data.\\.dockerconfigjson}')
              printf '%s' "$credential" | base64 -d > /tmp/dockerconfig.json
              kubectl -n ${ns} create secret generic ghcr-product-images --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/tmp/dockerconfig.json --dry-run=client -o yaml | kubectl -n ${ns} apply -f -
          resources:
            requests: {cpu: 10m, memory: 32Mi}
            limits: {cpu: 100m, memory: 128Mi}
`;
}

export async function publishRelease(github: GitHubWriter, release: ProductRelease, slug: string,
  helmRepo: string, gitopsRepo: string, owner: string, correlationId: string, domain = "gurkeschale.ch"): Promise<string> {
  const tree = await github.productRequest<{ truncated: boolean; tree: Array<{ path: string; type: string; mode: string; sha: string }> }>(
    release.sourceRepository, `/git/trees/${release.sourceCommit}?recursive=1`);
  if (tree.truncated) throw new Error("release tree truncated");
  const entries = tree.tree.filter((file) => file.path.startsWith(`${release.chartPath}/`) && file.type === "blob");
  if (!entries.some((file) => file.path === `${release.chartPath}/Chart.yaml`)) throw new Error("release has no Helm chart");
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error("unsupported chart file mode");
    const relative = entry.path.slice(release.chartPath.length + 1);
    if (relative.includes("..")) throw new Error("invalid chart path");
    const blob = await github.productRequest<{ content: string }>(release.sourceRepository, `/git/blobs/${entry.sha}`);
    files[`charts/ai-products/${slug}/${relative}`] = adaptChartFile(relative, Buffer.from(blob.content, "base64").toString("utf8"), slug, domain);
  }
  files[`charts/ai-products/${slug}/templates/factory-registry.yaml`] = pullSecretHook(slug);
  files[`charts/ai-products/${slug}/values-factory.yaml`] = `image:\n  repository: ${release.imageRepository}\n  digest: ${release.imageDigest}\ningress:\n  enabled: true\n  className: traefik-public\n  host: ${slug}.${domain}\n`;
  const helmCommit = await github.publishFiles(helmRepo, files, correlationId);
  await github.publishFiles(gitopsRepo, {
    [`applications/ai-products/${slug}.yaml`]: `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ai-product-${slug}
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/${owner}/${helmRepo}.git
    targetRevision: ${helmCommit}
    path: charts/ai-products/${slug}
    helm:
      releaseName: ${slug}
      valueFiles: [values.yaml, values-factory.yaml]
  destination:
    server: https://kubernetes.default.svc
    namespace: ai-product-${slug}
  syncPolicy:
    automated: {prune: true, selfHeal: true}
    syncOptions: [CreateNamespace=true]
`,
  }, correlationId);
  return helmCommit;
}
