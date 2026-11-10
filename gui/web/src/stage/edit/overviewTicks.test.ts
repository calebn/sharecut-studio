import { describe, expect, it } from "vitest";
import { overviewTicks } from "./overviewTicks";

describe("overviewTicks", () => {
  it("places comments and suggestions across the episode", () => {
    expect(
      overviewTicks({
        commentTimes: [15],
        suggestionTimes: [30, 45],
        durationSec: 60,
      }),
    ).toEqual([
      { at: 0.25, kind: "comment" },
      { at: 0.5, kind: "suggestion" },
      { at: 0.75, kind: "suggestion" },
    ]);
  });

  it("clamps past the ends and shares one suggestion tick between times past the end", () => {
    expect(
      overviewTicks({
        commentTimes: [-5],
        suggestionTimes: [70, 90],
        durationSec: 60,
      }),
    ).toEqual([
      { at: 0, kind: "comment" },
      { at: 1, kind: "suggestion" },
    ]);
  });

  it("draws nothing without a duration", () => {
    expect(
      overviewTicks({
        commentTimes: [1],
        suggestionTimes: [2],
        durationSec: 0,
      }),
    ).toEqual([]);
  });
});
