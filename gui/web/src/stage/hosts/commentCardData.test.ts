import { describe, expect, it } from "vitest";
import { sampleComment } from "../../test/fixtures";
import { commentCardOf } from "./commentCardData";

describe("commentCardOf", () => {
  it("keeps the time of a comment at a point or a range", () => {
    const point = commentCardOf(
      sampleComment({ timeline_start: 42 }),
      false,
      600,
    );
    expect(point.at).toEqual({ start: 42, end: undefined });
    const range = commentCardOf(
      sampleComment({ timeline_start: 10, timeline_end: 20 }),
      false,
      600,
    );
    expect(range.at).toEqual({ start: 10, end: 20 });
  });

  it("shows a whole-episode note with no time", () => {
    const note = commentCardOf(
      sampleComment({ timeline_start: 0, timeline_end: 600 }),
      false,
      600,
    );
    expect(note.at).toBeUndefined();
  });

  it("keeps the time when the duration is unknown", () => {
    const note = commentCardOf(
      sampleComment({ timeline_start: 0, timeline_end: 600 }),
      false,
      Number.NaN,
    );
    expect(note.at).toEqual({ start: 0, end: 600 });
  });
});
