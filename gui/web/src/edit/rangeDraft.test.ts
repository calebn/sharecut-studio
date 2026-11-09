import { describe, expect, it } from "vitest";
import { editFixtureProject, JONAS, MIRA } from "../test/actionBarFixtures";
import { minimalProject } from "../test/fixtures";
import { clampSpan, seedRangeDraft } from "./rangeSelection";

const project = editFixtureProject();
const withEnd = (end: number) => ({
  ...project,
  clips: { ...project.clips, timeline_duration_sec: end },
});

describe("clampSpan", () => {
  it.each([
    [{ start: 12, end: 17 }, 60, { start: 12, end: 17 }],
    [{ start: -2, end: 3 }, 60, { start: 0, end: 3 }],
    [{ start: 55, end: 60 }, 60, { start: 55, end: 60 }],
    [{ start: 58, end: 63 }, 60, { start: 58, end: 60 }],
    [{ start: 60, end: 65 }, 60, { start: 55, end: 60 }],
    [{ start: 70, end: 75 }, 60, { start: 55, end: 60 }],
    [{ start: 1, end: 6 }, 3, { start: 1, end: 3 }],
    [{ start: 3, end: 8 }, 3, { start: 0, end: 3 }],
    [{ start: 0, end: 5 }, 0, null],
  ])("holds %j inside 0–%d as %j", (span, end, expected) => {
    expect(clampSpan(span, end)).toEqual(expected);
  });
});

describe("seedRangeDraft", () => {
  it("starts at the playhead and runs 5 s on every track", () => {
    expect(seedRangeDraft(withEnd(60), 12, null)).toEqual({
      start: 12,
      end: 17,
      trackIds: [MIRA, JONAS],
    });
  });

  it("starts at 0 with the playhead at 0", () => {
    expect(seedRangeDraft(withEnd(60), 0, null)).toMatchObject({
      start: 0,
      end: 5,
    });
  });

  it("takes the last 5 s with the playhead at the end", () => {
    expect(seedRangeDraft(withEnd(60), 60, null)).toMatchObject({
      start: 55,
      end: 60,
    });
  });

  it("stops at the end within 5 s of it", () => {
    expect(seedRangeDraft(withEnd(60), 58, null)).toMatchObject({
      start: 58,
      end: 60,
    });
  });

  it("covers a timeline shorter than 5 s", () => {
    expect(seedRangeDraft(withEnd(3), 0, null)).toMatchObject({
      start: 0,
      end: 3,
    });
  });

  it("is null on an empty timeline", () => {
    expect(seedRangeDraft(minimalProject(), 0, null)).toBeNull();
  });

  it("is null without tracks", () => {
    expect(seedRangeDraft({ ...withEnd(60), tracks: [] }, 0, null)).toBeNull();
  });

  it("seeds the track the user targeted", () => {
    expect(
      seedRangeDraft(withEnd(60), 12, { kind: "track", trackId: JONAS })
        ?.trackIds,
    ).toEqual([JONAS]);
  });
});
