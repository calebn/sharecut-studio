import { describe, expect, it } from "vitest";
import type { ExactRangeTarget } from "../../types/project";
import {
  BOUNCE_DEFAULTS,
  bounceBlocker,
  bounceBody,
  bounceRangeSummary,
  bounceResultCopy,
} from "./bounceLogic";

const RANGE = {
  kind: "exact_range",
  intervals: [
    { start: 1, end: 2.5 },
    { start: 10.125, end: 12 },
  ],
  track_ids: ["a", "b"],
  clips: [],
} as unknown as ExactRangeTarget;

describe("bounceBlocker", () => {
  const none = { selected: 0, soloed: 0 };
  it("lets the whole mix go with nothing selected", () => {
    expect(bounceBlocker({ source: "entire" }, none, false)).toBeNull();
  });
  it("asks for tracks when the source needs them", () => {
    expect(bounceBlocker({ source: "selected" }, none, false)).toBe(
      "Select one or more tracks first.",
    );
    expect(bounceBlocker({ source: "soloed" }, none, false)).toBe(
      "Solo one or more tracks first.",
    );
    expect(
      bounceBlocker({ source: "selected" }, { selected: 1, soloed: 0 }, false),
    ).toBeNull();
    expect(
      bounceBlocker({ source: "soloed" }, { selected: 0, soloed: 2 }, false),
    ).toBeNull();
  });
  it("does not ask when a range fixes the source", () => {
    expect(bounceBlocker({ source: "selected" }, none, true)).toBeNull();
  });
});

describe("bounceBody", () => {
  const base = {
    choices: BOUNCE_DEFAULTS,
    selectedTrackIds: ["t1", "t2"],
    soloTracks: { a: true, b: false },
    region: { start_sec: 4, end_sec: 9 },
    range: null,
  };
  it("sends the entire mix as a WAV", () => {
    expect(bounceBody(base)).toEqual({
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
  });
  it("sends the selected or the soloed tracks", () => {
    expect(
      bounceBody({
        ...base,
        choices: { ...BOUNCE_DEFAULTS, source: "selected" },
      }).track_ids,
    ).toEqual(["t1", "t2"]);
    expect(
      bounceBody({ ...base, choices: { ...BOUNCE_DEFAULTS, source: "soloed" } })
        .track_ids,
    ).toEqual(["a"]);
  });
  it("limits to the region only when asked and one exists", () => {
    const limited = { ...BOUNCE_DEFAULTS, limitToRegion: true };
    expect(bounceBody({ ...base, choices: limited })).toMatchObject({
      start_s: 4,
      end_s: 9,
    });
    expect(
      bounceBody({ ...base, choices: limited, region: null }),
    ).toMatchObject({
      start_s: null,
      end_s: null,
    });
  });
  it("adds the MP3 after the WAV", () => {
    expect(
      bounceBody({ ...base, choices: { ...BOUNCE_DEFAULTS, includeMp3: true } })
        .formats,
    ).toEqual(["wav", "mp3"]);
  });
  it("sends only the fixed range, whatever else is chosen", () => {
    expect(
      bounceBody({
        ...base,
        choices: { source: "soloed", includeMp3: true, limitToRegion: true },
        range: RANGE,
      }),
    ).toEqual({
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav", "mp3"],
      exact_range: RANGE,
    });
  });
});

describe("copy", () => {
  it("lists the intervals and the tracks of a range", () => {
    expect(bounceRangeSummary(RANGE)).toBe(
      "1.00–2.50 s · 10.13–12.00 s on a, b",
    );
  });
  it("counts the files written", () => {
    expect(bounceResultCopy(["a.wav", "a.mp3"])).toBe(
      "Bounced 2 file(s) to export/bounces/",
    );
  });
});
