import { readFile } from "node:fs/promises";
import { request } from "node:https";

export async function applicationReady(slug: string, revision: string): Promise<boolean> {
  const folder = "/var/run/secrets/kubernetes.io/serviceaccount";
  const [token, ca] = await Promise.all([readFile(`${folder}/token`, "utf8"), readFile(`${folder}/ca.crt`)]);
  const data = await new Promise<string>((resolve, reject) => {
    const req = request(`https://kubernetes.default.svc/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/ai-product-${slug}`,
      { ca, headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => { body += part; });
        res.on("end", () => res.statusCode === 200 ? resolve(body) :
          res.statusCode === 404 ? resolve("{}") : reject(new Error(`Argo status read failed: ${res.statusCode}`)));
      });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Argo status read timed out")));
    req.end();
  });
  const app = JSON.parse(data) as { spec?: { source?: { targetRevision: string } }; status?: {
    sync?: { status: string; revision: string }; health?: { status: string }; operationState?: { phase: string };
  } };
  return app.spec?.source?.targetRevision === revision && app.status?.sync?.revision === revision &&
    app.status.sync.status === "Synced" && app.status.health?.status === "Healthy" &&
    app.status.operationState?.phase === "Succeeded";
}

export async function frontendReady(slug: string): Promise<boolean> {
  const response = await fetch(`https://${slug}.ai-products.gurkeschale.ch/`, {
    signal: AbortSignal.timeout(15_000), redirect: "manual",
  });
  await response.body?.cancel();
  return response.status === 200;
}
