import { describe, expect, it } from "vitest";
import { productPitchSchema } from "./index.js";

describe("productPitchSchema", () => {
  it("rejects unsafe slugs", () => {
    const result = productPitchSchema.safeParse({
      id: "f6a0bec1-f4d6-418d-bbb7-caf29f29470a",
      windowId: "0001989940",
      slug: "../unsafe",
      name: "Unsafe",
      targetAudience: "Test",
      problem: "Test",
      valueProposition: "Test",
      scope: ["Test"],
      differentiation: "Test",
      revenueHypothesis: "Test",
      risks: ["Test"],
      validationPlan: "Test",
      evidence: [],
    });
    expect(result.success).toBe(false);
  });
});
