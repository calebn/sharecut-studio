import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractClip,
  type ContractSource,
  type ContractTrack,
  contractClipRow,
} from "../test/contractProject";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import { clampToRollInterval, rollJoinInterval } from "./rollLimits";

describe("recording-aware roll regressions", () => {
  const left = clipRow({
    id: "left",
    source_id: "take-left",
    recording_key: "rec-left",
    source_start: 0,
    source_end: 10,
    source_duration_sec: 30,
    timeline_start: 0,
    timeline_end: 10,
  });
  const right = clipRow({
    id: "right",
    source_id: "take-right",
    recording_key: "rec-right",
    source_start: 10,
    source_end: 20,
    timeline_start: 10,
    timeline_end: 20,
  });
  const after = clipRow({
    id: "after",
    source_id: "take-other",
    recording_key: "rec-other",
    source_start: 11,
    source_end: 15,
    timeline_start: 20,
    timeline_end: 24,
  });

  it.each([
    {
      name: "longer left recording",
      duration: 30,
      trackDuration: 11,
      following: false,
      expected: 3,
    },
    {
      name: "shorter left recording",
      duration: 11,
      trackDuration: 30,
      following: false,
      expected: 1,
    },
    {
      name: "unrelated following recording",
      duration: 30,
      trackDuration: 30,
      following: true,
      expected: 3,
    },
    {
      name: "unknown left duration",
      duration: null,
      trackDuration: 30,
      following: false,
      expected: 0,
    },
  ])("$name", ({ duration, trackDuration, following, expected }) => {
    const l = { ...left, source_duration_sec: duration };
    const project = minimalProject({
      tracks: [sampleTrack({ id: l.track_id, duration_sec: trackDuration })],
      clips: {
        tracks: { [l.track_id]: following ? [l, right, after] : [l, right] },
        clip_count: following ? 3 : 2,
      },
    });
    const interval = rollJoinInterval(
      project.clips.tracks[l.track_id] ?? [],
      l.id,
      right.id,
    );
    if (!interval) throw new Error("missing roll pair");
    expect(clampToRollInterval(3, interval)).toBe(expected);
  });
});

type RollContract = {
  tracks: ContractTrack[];
  sources: ContractSource[];
  cases: {
    name: string;
    clips: ContractClip[];
    left_clip_id: string;
    right_clip_id: string;
    limits?: [number, number];
    clamps?: [number, number][];
    error?: boolean;
  }[];
};

const CONTRACT = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../contracts/roll-join-limits.json"),
    "utf8",
  ),
) as RollContract;

describe("roll interval and clamp parity with Python", () => {
  it.each(CONTRACT.cases)("$name", (c) => {
    const track = CONTRACT.tracks[0];
    if (!track) throw new Error("no contract track");
    const lane = c.clips.map((row) =>
      contractClipRow(track, CONTRACT.sources, row),
    );
    const interval = rollJoinInterval(lane, c.left_clip_id, c.right_clip_id);
    if (c.error) {
      expect(interval).toBeNull();
      return;
    }
    if (!interval || !c.limits || !c.clamps)
      throw new Error("missing contract interval");
    expect([interval.lo, interval.hi]).toEqual(
      c.limits.map((v) => expect.closeTo(v, 9)),
    );
    for (const [requested, expected] of c.clamps) {
      expect(clampToRollInterval(requested, interval)).toBeCloseTo(expected, 9);
    }
    expect(interval.left.id).toBe(c.left_clip_id);
    expect(interval.right.id).toBe(c.right_clip_id);
  });

  it("refuses a pair on different lanes", () => {
    expect(
      rollJoinInterval(
        [
          clipRow({
            id: "left",
            track_id: "host",
            timeline_start: 0,
            timeline_end: 4,
          }),
          clipRow({ id: "right", track_id: "guest", timeline_start: 4 }),
        ],
        "left",
        "right",
      ),
    ).toBeNull();
  });
});
