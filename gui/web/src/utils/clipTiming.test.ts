import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TIME_EPS_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";
import {
  clipShiftAt,
  clipSourceToTimeline,
  clipSourceToTimelineNearest,
  clipTimelineEnd,
  clipTimelineSpanSec,
  clipTimelineToSource,
  clipTimingDelta,
  clipVirtualPieces,
  stepsWithin,
  timingSummary,
} from "./clipTiming";
import {
  sourcePointToTimeline,
  sourceSecInClipToTimeline,
  timelinePointToSource,
} from "./timebase";

type Pair = [number, number | null];
interface FixtureCase {
  name: string;
  summary: string | null;
  clip: {
    id: string;
    track_id: string;
    source_start: number;
    source_end: number;
    timeline_start: number;
    timing?: { steps: { at: number; delta_sec: number }[] };
  };
  timeline_end: number;
  pieces: [number, number, number][];
  source_to_timeline: Pair[];
  timeline_to_source: Pair[];
  shift_at: [number, number][];
}

const FIXTURE = JSON.parse(
  readFileSync(
    `${process.cwd()}/../../tests/fixtures/timing_map/cases.json`,
    "utf8",
  ),
);
const CASES: FixtureCase[] = FIXTURE.cases;
const SUMMARY_CASES: { deltas: number[]; summary: string }[] =
  FIXTURE.summary_cases.cases;

function timedClip(c: FixtureCase) {
  const { timing, ...rest } = c.clip;
  return {
    ...rest,
    timeline_end: c.timeline_end,
    ...(timing
      ? { timing: { method: "x", micro_fade_ms: 10, ...timing } }
      : {}),
  } as ClipRow;
}

describe("clip timing pinned to Clip in models/episode.py (#2862)", () => {
  it.each(CASES)("virtual pieces and timeline end: $name", (c) => {
    const clip = timedClip(c);
    expect(clipVirtualPieces(clip).map((p) => [p.srcA, p.srcB, p.tlA])).toEqual(
      c.pieces,
    );
    expect(clipTimelineEnd(clip)).toBeCloseTo(c.timeline_end, 9);
    expect(clipTimelineSpanSec(clip)).toBeCloseTo(
      c.timeline_end - c.clip.timeline_start,
      9,
    );
  });

  it.each(CASES)("source to timeline: $name", (c) => {
    const clip = timedClip(c);
    for (const [source, expected] of c.source_to_timeline) {
      expect(clipSourceToTimeline(clip, source)).toBe(expected);
    }
  });

  it.each(CASES)("timeline to source: $name", (c) => {
    const clip = timedClip(c);
    for (const [timeline, expected] of c.timeline_to_source) {
      expect(clipTimelineToSource(clip, timeline)).toBe(expected);
    }
  });

  it.each(CASES)("shift at a source second: $name", (c) => {
    const clip = timedClip(c);
    for (const [source, expected] of c.shift_at) {
      expect(clipShiftAt(clip, source)).toBe(expected);
    }
  });

  it.each(CASES)("summary: $name", (c) => {
    if (c.summary === null) {
      expect(timingSummary(c.clip.timing?.steps ?? [])).toBe("");
      return;
    }
    expect(timingSummary(c.clip.timing?.steps ?? [])).toBe(c.summary);
  });

  it.each(SUMMARY_CASES)("summary rounds half up: $deltas", (c) => {
    const steps = c.deltas.map((delta_sec, i) => ({
      at: 12 + 5 * i,
      delta_sec,
    }));
    expect(timingSummary(steps)).toBe(c.summary);
  });

  it("says 1 correction in the singular whatever its size", () => {
    expect(timingSummary([{ delta_sec: -0.25 }])).toBe("1 correction");
  });

  it("floors the largest step at 1 ms", () => {
    expect(
      timingSummary([{ delta_sec: 0.00001 }, { delta_sec: 0.00001 }]),
    ).toBe("2 corrections, largest 1 ms");
  });
});

describe("untimed clips keep the linear map", () => {
  const untimed = timedClip(CASES[0]!);

  it("is one piece with the linear shift", () => {
    expect(clipVirtualPieces(untimed)).toEqual([
      { srcA: 10, srcB: 40, tlA: 100 },
    ]);
    expect(clipShiftAt(untimed, 25)).toBe(90);
    expect(clipTimelineEnd(untimed)).toBe(130);
  });

  it("agrees with the wrappers at every checked point", () => {
    for (const [source, expected] of CASES[0]!.source_to_timeline) {
      if (expected !== null && source < 40) {
        expect(sourcePointToTimeline([untimed], source)).toBe(expected);
      }
    }
    expect(timelinePointToSource([untimed], 115)).toBe(25);
  });
});

describe("wrappers follow the pieces of a timed clip", () => {
  const hole = timedClip(CASES.find((c) => c.name === "hole")!);
  const skip = timedClip(CASES.find((c) => c.name === "skip")!);

  it("timelinePointToSource is null in a hole and exact after it", () => {
    expect(timelinePointToSource([hole], 105)).toBe(15);
    expect(timelinePointToSource([hole], 110.5)).toBeNull();
    expect(timelinePointToSource([hole], 112)).toBe(20);
    expect(timelinePointToSource([hole], 131)).toBe(39);
    expect(timelinePointToSource([hole], 132)).toBeNull();
  });

  it("sourcePointToTimeline is null in a skipped span and half-open at the end", () => {
    expect(sourcePointToTimeline([skip], 19)).toBe(109);
    expect(sourcePointToTimeline([skip], 21)).toBeNull();
    expect(sourcePointToTimeline([skip], 23)).toBe(110);
    expect(sourcePointToTimeline([skip], 40)).toBeNull();
  });

  it("sourceSecInClipToTimeline lands a skipped span on the join and keeps the out point", () => {
    expect(sourceSecInClipToTimeline(skip, 21)).toBe(110);
    expect(sourceSecInClipToTimeline(skip, 40)).toBe(127);
    expect(sourceSecInClipToTimeline(hole, 20)).toBe(112);
    expect(sourceSecInClipToTimeline(hole, 40)).toBe(132);
  });

  it("nearest map extends the outer pieces linearly", () => {
    expect(clipSourceToTimelineNearest(skip, 9)).toBe(99);
    expect(clipSourceToTimelineNearest(skip, 41)).toBe(128);
  });
});

describe("wrappers snap within the time epsilon", () => {
  const hole = timedClip(CASES.find((c) => c.name === "hole")!);
  const skip = timedClip(CASES.find((c) => c.name === "skip")!);
  const half = TIME_EPS_SEC / 2;

  it("lands a point just before a piece start on that piece", () => {
    expect(timelinePointToSource([hole], 112 - half)).toBeCloseTo(20, 8);
    expect(timelinePointToSource([hole], 112 - 2 * TIME_EPS_SEC)).toBeNull();
    expect(sourcePointToTimeline([skip], 23 - half)).toBeCloseTo(110, 8);
    expect(sourcePointToTimeline([skip], 23 - 2 * TIME_EPS_SEC)).toBeNull();
  });
});

describe("steps inside a live range", () => {
  const timing = {
    method: "bleed_lag",
    micro_fade_ms: 10,
    steps: [
      { at: 20, delta_sec: 1 },
      { at: 35, delta_sec: -3 },
    ],
  };

  it("keeps a skip only when it ends inside the range", () => {
    expect(stepsWithin(timing, 10, 38).map((s) => s.at)).toEqual([20, 35]);
    expect(stepsWithin(timing, 10, 37).map((s) => s.at)).toEqual([20]);
  });

  it("drops a step at or outside either bound", () => {
    expect(stepsWithin(timing, 20, 40).map((s) => s.at)).toEqual([35]);
    expect(stepsWithin(timing, 10, 20)).toEqual([]);
  });
});

describe("a row that names steps but carries none", () => {
  const row = (over: Partial<ClipRow>) =>
    ({
      source_start: 10,
      source_end: 40,
      timeline_start: 100,
      timeline_end: 130,
      ...over,
    }) as ClipRow;

  it("reads the extra timeline length from its own end", () => {
    expect(clipTimingDelta(row({ timeline_end: 132, timing_steps: 1 }))).toBe(
      2,
    );
    expect(clipTimingDelta(row({ timeline_end: 127, timing_steps: 1 }))).toBe(
      -3,
    );
  });

  it("adds nothing without steps", () => {
    expect(clipTimingDelta(row({}))).toBe(0);
    expect(clipTimingDelta(row({ timing_steps: 0 }))).toBe(0);
  });
});
