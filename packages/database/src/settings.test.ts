import { expect, it } from "vitest";
import { settingsPermitNewWork, type FactorySettings } from "./index.js";

const settings: FactorySettings = {
  automationEnabled: true, emergencyStop: false, portfolioRevision: 0,
  llmBudgetLimitsEnabled: false, dailyLlmCostLimitChf: null, dailyTokenLimit: null,
  buildTimeoutSeconds: 1800, maxOccupiedSlots: 10, maxParallelBuilds: 1,
  maxDevelopmentRounds: 3, pitchIntervalMinutes: 1,
};

it("allows an explicit temporary budget override without disabling the emergency stop", () => {
  expect(settingsPermitNewWork(settings)).toBe(true);
  expect(settingsPermitNewWork({ ...settings, llmBudgetLimitsEnabled: true })).toBe(false);
  expect(settingsPermitNewWork({ ...settings, emergencyStop: true })).toBe(false);
  expect(settingsPermitNewWork({ ...settings, automationEnabled: false })).toBe(false);
});
