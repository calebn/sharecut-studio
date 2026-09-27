import { describe, expect, it } from "vitest";
import { isTerminalJobStatus } from "./pipeline";

describe("isTerminalJobStatus", () => {
  it("is true for ok, error and cancelled", () => {
    for (const s of ["ok", "error", "cancelled"]) {
      expect(isTerminalJobStatus(s)).toBe(true);
    }
  });
  it("is false for live or unknown statuses", () => {
    for (const s of ["queued", "running", "", "bogus"]) {
      expect(isTerminalJobStatus(s)).toBe(false);
    }
  });
});
