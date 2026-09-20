import { describe, expect, it } from "vitest";
import { snapToVisibleAnchors } from "./snap";

describe("snapToVisibleAnchors", () => {
  it("snaps to nearest visible anchor within threshold", () => {
    const r = snapToVisibleAnchors(10.04, [0, 10, 20], 5, 15, 0.1);
    expect(r.snapped).toBe(true);
    expect(r.sec).toBe(10);
    expect(r.anchor).toBe(10);
  });

  it("ignores off-screen anchors", () => {
    const r = snapToVisibleAnchors(10.02, [0, 10, 20], 12, 30, 0.1);
    expect(r.snapped).toBe(false);
    expect(r.sec).toBe(10.02);
  });

  it("does not snap outside threshold", () => {
    const r = snapToVisibleAnchors(10.5, [10], 0, 20, 0.1);
    expect(r.snapped).toBe(false);
  });
});
