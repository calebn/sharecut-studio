import { describe, expect, it } from "vitest";
import type { ClipRow } from "../../types/project";
import {
  movableParticipants,
  participantClips,
  recordSourcePrefix,
  remapMoves,
} from "./recordRemapModel";

const clip = (id: string, source: string | null, start: number, track = "t1") =>
  ({
    id,
    track_id: track,
    source_id: source,
    timeline_start: start,
  }) as ClipRow;

const tracks = {
  t1: [
    clip("c1", "rec-s1-0-pa-x", 1.5),
    clip("c2", "rec-s1-12-pa-x", 20),
    clip("c3", "rec-s1-0-pb-x", 2),
    clip("c4", null, 3),
  ],
  t2: [
    clip("c5", "rec-s10-0-pa-x", 4, "t2"),
    clip("c6", "rec-s2-0-pa-x", 5, "t2"),
    clip("c7", "rec-s1-0-pab-x", 6, "t2"),
  ],
};

describe("recordRemapModel", () => {
  it("builds the session prefix", () => {
    expect(recordSourcePrefix("s1")).toBe("rec-s1-");
  });

  it("keeps only the participant's clips of that session across takes and tracks", () => {
    const all = Object.values(tracks).flat();
    expect(participantClips(all, "s1", "pa").map((c) => c.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("does not mistake rec-s1- for rec-s10- or pa for pab", () => {
    const all = Object.values(tracks).flat();
    expect(participantClips(all, "s10", "pa").map((c) => c.id)).toEqual(["c5"]);
    expect(participantClips(all, "s1", "pab").map((c) => c.id)).toEqual(["c7"]);
  });

  it("treats regex characters in an id literally", () => {
    const odd = [
      clip("x", "rec-s1-0-a.b-x", 0),
      clip("y", "rec-s1-0-aXb-x", 0),
    ];
    expect(participantClips(odd, "s1", "a.b").map((c) => c.id)).toEqual(["x"]);
  });

  it("moves every clip to the track keeping each start", () => {
    expect(remapMoves(tracks, "s1", "pa", "t9")).toEqual([
      { clip_id: "c1", timeline_start: 1.5, track_id: "t9" },
      { clip_id: "c2", timeline_start: 20, track_id: "t9" },
    ]);
    expect(remapMoves(undefined, "s1", "pa", "t9")).toEqual([]);
  });

  it("lists the participants that have clips", () => {
    expect([...movableParticipants(tracks, "s1", ["pa", "pb", "pz"])]).toEqual([
      "pa",
      "pb",
    ]);
  });
});
