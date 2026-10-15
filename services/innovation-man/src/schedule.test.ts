import { expect, it } from "vitest";
import { currentWindowId } from "./schedule.js";

it("allows one pitch per minute during temporary fast mode", () => {
  const now = Date.UTC(2026, 9, 15, 20, 0);
  expect(currentWindowId(1, now)).toBe(currentWindowId(1, now + 59_999));
  expect(currentWindowId(1, now)).not.toBe(currentWindowId(1, now + 60_000));
});

it("preserves the normal fifteen minute windows", () => {
  const now = Date.UTC(2026, 9, 15, 20, 0);
  expect(currentWindowId(15, now)).toBe(currentWindowId(15, now + 14 * 60_000));
  expect(currentWindowId(15, now)).not.toBe(currentWindowId(15, now + 15 * 60_000));
  expect(() => currentWindowId(0, now)).toThrow();
});
