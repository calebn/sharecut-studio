import { describe, expect, it } from "vitest";
import { pendingSpanAfterDrag } from "./pendingSpanDrag";

describe("pendingSpanAfterDrag", () => {
  it("moves the start edge by dx", () => {
    expect(pendingSpanAfterDrag("start", 1, 3, 0.5)).toEqual({
      start: 1.5,
      end: 3,
    });
  });

  it("clamps the start edge to end - 0.05", () => {
    const { start, end } = pendingSpanAfterDrag("start", 1, 3, 5);
    expect(start).toBeCloseTo(2.95, 6);
    expect(end).toBe(3);
  });

  it("moves the end edge by dx", () => {
    expect(pendingSpanAfterDrag("end", 1, 3, -0.5)).toEqual({
      start: 1,
      end: 2.5,
    });
  });

  it("clamps the end edge to start + 0.05", () => {
    const { start, end } = pendingSpanAfterDrag("end", 1, 3, -5);
    expect(start).toBe(1);
    expect(end).toBeCloseTo(1.05, 6);
  });
});
