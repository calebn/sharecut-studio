import { describe, expect, it } from "vitest";
import {
  boundedDelta,
  edgeBounds,
  spanBounds,
  UNBOUNDED,
  within,
} from "./dragBounds";

describe("dragBounds", () => {
  it("holds a selection edge to the episode and off the other edge", () => {
    const selection = { start: 10, end: 20 };
    expect(edgeBounds("start", selection, 100, 0.01)).toEqual([0, 19.99]);
    expect(edgeBounds("end", selection, 100, 0.01)).toEqual([10.01, 100]);
  });

  it("holds a moved span inside the episode and keeps its length", () => {
    expect(spanBounds("move", 30, 42, 50, 0.1)).toEqual([0, 38]);
    expect(spanBounds("start", 30, 42, 50, 0.1)).toEqual([0, 41.9]);
    expect(spanBounds("end", 30, 42, 50, 0.1)).toEqual([30.1, 50]);
  });

  it("does not pin a span longer than the episode, or any span while the duration is 0", () => {
    expect(spanBounds("move", 10, 70, 36, 0.1)).toBe(UNBOUNDED);
    expect(spanBounds("move", 10, 46, 36, 0.1)).toBe(UNBOUNDED);
    expect(spanBounds("move", 20, 20, 0, 0.1)).toBe(UNBOUNDED);
    expect(spanBounds("start", 20, 30, 0, 0.1)).toBe(UNBOUNDED);
    expect(spanBounds("end", 20, 30, 0, 0.1)).toBe(UNBOUNDED);
    expect(spanBounds("end", 50, 60, 36, 0.1)).toBe(UNBOUNDED);
    expect(boundedDelta(UNBOUNDED, 10, 5)).toBe(5);
  });

  it("clamps a delta so the value stays inside, and ignores a non-finite one", () => {
    expect(boundedDelta([0, 38], 30, 100)).toBe(8);
    expect(boundedDelta([0, 38], 30, -100)).toBe(-30);
    expect(boundedDelta([0, 38], 30, 2)).toBe(2);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(boundedDelta([0, 38], 30, bad)).toBe(0);
    }
    expect(within([0, 10], 12)).toBe(10);
  });
});
