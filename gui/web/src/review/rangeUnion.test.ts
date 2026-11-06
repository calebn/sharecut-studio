import { describe, expect, it } from "vitest";
import { unionSeconds } from "./rangeUnion";

describe("unionSeconds", () => {
  it("counts overlaps, nesting and adjacency once", () => {
    expect(
      unionSeconds([
        [0, 5],
        [5, 10],
      ]),
    ).toBe(10);
    expect(
      unionSeconds([
        [1, 3],
        [2, 4],
      ]),
    ).toBe(3);
    expect(
      unionSeconds([
        [0, 10],
        [2, 3],
      ]),
    ).toBe(10);
  });

  it("ignores empty, reversed and non-finite ranges", () => {
    expect(
      unionSeconds([
        [5, 5],
        [7, 6],
        [Number.NaN, 9],
        [0, Number.POSITIVE_INFINITY],
      ]),
    ).toBe(0);
  });
});
