import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { sessionClipSet, sessionHandoff } from "./sessionClips";

const clip = (
  id: string,
  source: string | null,
  start: number,
  end: number,
  track = "t1",
) =>
  ({
    id,
    track_id: track,
    source_id: source,
    timeline_start: start,
    timeline_end: end,
  }) as ClipRow;

const tracks = {
  t1: [clip("a", "rec-s1-0-x", 2, 4), clip("b", "rec-s1-1-x", 9, 12)],
  t2: [
    clip("c", "rec-s1-0-y", 1, 3, "t2"),
    clip("d", "rec-s10-0-y", 5, 50, "t2"),
  ],
};

describe("sessionClipSet", () => {
  it("spans the earliest start to the latest end across tracks and takes", () => {
    expect(sessionClipSet(tracks, "s1")).toEqual({
      startSec: 1,
      endSec: 12,
      primary: { id: "c", trackId: "t2" },
      clipIds: ["c", "a", "b"],
    });
  });

  it("does not match a longer id that shares the prefix", () => {
    expect(sessionClipSet(tracks, "s10")?.clipIds).toEqual(["d"]);
  });

  it("is null when no clip landed", () => {
    expect(sessionClipSet(tracks, "gone")).toBeNull();
    expect(sessionClipSet(undefined, "s1")).toBeNull();
  });

  it("hand-off drops the end", () => {
    expect(sessionHandoff(tracks, "s1")).toEqual({
      startSec: 1,
      primary: { id: "c", trackId: "t2" },
      clipIds: ["c", "a", "b"],
    });
  });
});
