import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = new Date(2026, 9, 27, 12, 0);

describe("relativeTime", () => {
  it("reads minutes, hours and days", () => {
    expect(
      relativeTime(new Date(2026, 9, 27, 11, 59, 40).toISOString(), NOW),
    ).toBe("just now");
    expect(relativeTime(new Date(2026, 9, 27, 11, 48).toISOString(), NOW)).toBe(
      "12 min ago",
    );
    expect(relativeTime(new Date(2026, 9, 27, 9, 0).toISOString(), NOW)).toBe(
      "3 h ago",
    );
    expect(relativeTime(new Date(2026, 9, 26, 23, 0).toISOString(), NOW)).toBe(
      "yesterday",
    );
    expect(relativeTime(new Date(2026, 9, 24, 9, 0).toISOString(), NOW)).toBe(
      "3 days ago",
    );
    expect(relativeTime(new Date(2026, 8, 1, 9, 0).toISOString(), NOW)).toBe(
      "1 Sep",
    );
  });
  it("is empty for a missing or broken time", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime("nonsense", NOW)).toBe("");
  });
});
