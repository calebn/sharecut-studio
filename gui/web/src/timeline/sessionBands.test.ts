import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { bandSelected, sessionBands } from "./sessionBands";

const clip = (id: string, source: string, start: number, end: number) =>
  ({
    id,
    track_id: "t1",
    source_id: source,
    timeline_start: start,
    timeline_end: end,
  }) as ClipRow;

const tracks = {
  t1: [
    clip("a", "rec-s1-0-x", 0, 10),
    clip("b", "rec-s2-0-x", 30, 40),
    clip("c", "rec-s10-0-x", 5, 8),
  ],
};
const row = (
  session_id: string,
  number: number | null,
  name: string | null = null,
) => ({
  session_id,
  number,
  name,
});

describe("sessionBands", () => {
  it("labels each numbered session S<n> with its extent, in start order", () => {
    const bands = sessionBands(tracks, [row("s2", 2, "Pickups"), row("s1", 1)]);
    expect(bands.map((b) => [b.label, b.title, b.start, b.end])).toEqual([
      ["S1", "Session 1", 0, 10],
      ["S2", "Session 2 - Pickups", 30, 40],
    ]);
  });

  it("keeps rec-s1- apart from rec-s10-", () => {
    const [band] = sessionBands(tracks, [row("s10", 10)]);
    expect(band.clipIds).toEqual(["c"]);
  });

  it("draws no band for an unnumbered session or one without clips (undo)", () => {
    expect(sessionBands(tracks, [row("s1", null), row("zz", 3)])).toEqual([]);
  });

  it("keeps overlapping sessions as separate bands", () => {
    const overlap = {
      t1: [clip("a", "rec-s1-0-x", 0, 10), clip("b", "rec-s2-0-x", 4, 6)],
    };
    expect(sessionBands(overlap, [row("s1", 1), row("s2", 2)])).toHaveLength(2);
  });
});

describe("bandSelected", () => {
  it("is true only for exactly the band's clips", () => {
    const band = { clipIds: ["a", "b"] };
    expect(bandSelected(band, ["b", "a"])).toBe(true);
    expect(bandSelected(band, ["a"])).toBe(false);
    expect(bandSelected(band, ["a", "b", "c"])).toBe(false);
  });
});
