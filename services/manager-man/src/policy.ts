import type { PortfolioDecision, ProductPitch } from "@factory/contracts";
import type { FactorySettings } from "@factory/database";

export interface Incumbent {
  id: string;
  score: number | null;
  hasRealUsers: boolean;
  hasPersistentData: boolean;
  createdAt: Date;
}

export interface PolicyInput {
  settings: FactorySettings;
  decision: PortfolioDecision;
  pitch: ProductPitch;
  occupiedSlots: number;
  activeBuilds: number;
  incumbent: Incumbent | null;
  now?: Date;
}

export type PolicyResult =
  | { approved: true; operation: "ADMIT" | "REPLACE" }
  | { approved: false; reason: string };

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { settings, decision, pitch, occupiedSlots, activeBuilds, incumbent } = input;
  const now = input.now ?? new Date();
  if (!settings.automationEnabled) return { approved: false, reason: "automation is disabled" };
  if (settings.emergencyStop) return { approved: false, reason: "emergency stop is active" };
  if (settings.dailyLlmCostLimitChf === null || settings.dailyTokenLimit === null || settings.buildTimeoutSeconds === null) {
    return { approved: false, reason: "required limits are missing" };
  }
  if (decision.portfolioRevision !== settings.portfolioRevision) {
    return { approved: false, reason: "portfolio revision is stale" };
  }
  if (decision.recommendation === "BACKLOG" || decision.recommendation === "REJECT") {
    return { approved: false, reason: `recommendation is ${decision.recommendation}` };
  }
  if (occupiedSlots >= settings.maxOccupiedSlots) {
    return { approved: false, reason: "no portfolio slot is available" };
  }
  if (activeBuilds >= settings.maxParallelBuilds) {
    return { approved: false, reason: "the parallel build limit is reached" };
  }
  if (decision.recommendation === "ADMIT") {
    return decision.score >= 70
      ? { approved: true, operation: "ADMIT" }
      : { approved: false, reason: "admission score is below 70" };
  }

  const replacement = decision.replacement;
  if (!replacement || !incumbent || replacement.productId !== incumbent.id) {
    return { approved: false, reason: "replacement target is missing or inconsistent" };
  }
  if (decision.score < 75) return { approved: false, reason: "replacement score is below 75" };
  const incumbentScore = incumbent.score ?? replacement.incumbentScore;
  if (decision.score - incumbentScore < 15) {
    return { approved: false, reason: "replacement score advantage is below 15" };
  }
  const evidenceGroups = new Set(
    pitch.evidence
      .filter((evidence) => decision.evidenceIds.includes(evidence.id))
      .map((evidence) => evidence.independentGroup),
  );
  if (evidenceGroups.size < 2) {
    return { approved: false, reason: "replacement lacks two independent evidence groups" };
  }
  const minimumAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (now.getTime() - incumbent.createdAt.getTime() < minimumAgeMs) {
    return { approved: false, reason: "incumbent is protected by the seven-day minimum runtime" };
  }
  if ((incumbent.hasRealUsers || incumbent.hasPersistentData) && !replacement.humanApprovalId) {
    return { approved: false, reason: "human approval is required for this replacement" };
  }
  return { approved: true, operation: "REPLACE" };
}
