import { describe, expect, it } from "vitest";
import type { PortfolioDecision, ProductPitch } from "@factory/contracts";
import type { FactorySettings } from "@factory/database";
import { evaluatePolicy } from "./policy.js";

const settings: FactorySettings = {
  automationEnabled: true,
  emergencyStop: false,
  portfolioRevision: 4,
  dailyLlmCostLimitChf: 10,
  llmBudgetLimitsEnabled: true,
  dailyTokenLimit: 100_000,
  buildTimeoutSeconds: 1800,
  maxOccupiedSlots: 10,
  maxParallelBuilds: 1,
  maxDevelopmentRounds: 3,
  pitchIntervalMinutes: 30,
};

const pitch = {
  id: "1586bbc5-923d-4597-b305-3d03fb58e18f",
  windowId: "0001989940",
  slug: "example-product",
  name: "Example",
  targetAudience: "Teams",
  problem: "A problem",
  valueProposition: "A value",
  scope: ["MVP"],
  differentiation: "Focused",
  revenueHypothesis: "Subscription",
  risks: ["Demand"],
  validationPlan: "Interview users",
  evidence: [],
} satisfies ProductPitch;

it("admits a qualifying pitch when a slot is free", () => {
  const decision = {
    id: "d615fabe-2324-48b1-b43a-7afe341e028a",
    pitchId: pitch.id,
    portfolioRevision: 4,
    score: 80,
    recommendation: "ADMIT",
    rationale: ["Good fit"],
    risks: [],
    evidenceIds: [],
  } satisfies PortfolioDecision;
  expect(evaluatePolicy({ settings, decision, pitch, occupiedSlots: 9, activeBuilds: 0, incumbent: null })).toEqual({
    approved: true,
    operation: "ADMIT",
  });
});

describe("hard policy guards", () => {
  it("blocks work when all slots are occupied", () => {
    const decision = {
      id: "d615fabe-2324-48b1-b43a-7afe341e028a",
      pitchId: pitch.id,
      portfolioRevision: 4,
      score: 95,
      recommendation: "ADMIT",
      rationale: ["High score"],
      risks: [],
      evidenceIds: [],
    } satisfies PortfolioDecision;
    expect(evaluatePolicy({ settings, decision, pitch, occupiedSlots: 10, activeBuilds: 0, incumbent: null }).approved).toBe(false);
  });
});
