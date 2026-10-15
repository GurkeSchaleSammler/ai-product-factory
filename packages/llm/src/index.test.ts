import { describe, expect, it } from "vitest";
import { normalizeLlmStringList } from "./index.js";

describe("normalizeLlmStringList", () => {
  it("preserves arrays", () => {
    const input = ["first", "second"];
    expect(normalizeLlmStringList(input)).toBe(input);
  });

  it("turns a plain string into a one-item list", () => {
    expect(normalizeLlmStringList("Build the smallest useful MVP")).toEqual([
      "Build the smallest useful MVP",
    ]);
  });

  it("splits bullet and semicolon separated model output", () => {
    expect(normalizeLlmStringList("- First\n- Second; Third")).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("parses an array serialized inside a JSON string", () => {
    expect(normalizeLlmStringList('["first","second"]')).toEqual(["first", "second"]);
  });
});
