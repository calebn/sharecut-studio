import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { clipGainDips } from "./clipGainOverlay";

function clip(over: Partial<ClipRow>): ClipRow {
  return {
    id: "c1",
    track_id: "t1",
    source_start: 0,
    source_end: 10,
    timeline_start: 0,
    timeline_end: 10,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    join_left_clip_id: null,
    source_id: "s1",
    source_duration_sec: 20,
    recording_key: null,
    ...over,
  } as ClipRow;
}

const unity = [{ time: 0, value: 1 }];

describe("clipGainDips", () => {
  it("draws nothing for a clip with no fade or mute", () => {
    expect(clipGainDips([clip({})], unity)).toEqual([]);
  });

  it("draws a fade-in as a ramp from 0 to the envelope level", () => {
    const [dip] = clipGainDips(
      [clip({ fade_in_ms: 500 })],
      [{ time: 0, value: 0.5 }],
    );
    expect(dip?.points[0]).toEqual({ time: 0, gain: 0 });
    expect(dip?.points.at(-1)?.time).toBeCloseTo(0.5);
    expect(dip?.points.at(-1)?.gain).toBeCloseTo(0.5);
  });

  it("moves with its clip", () => {
    const [dip] = clipGainDips(
      [clip({ timeline_start: 4, timeline_end: 14, fade_in_ms: 500 })],
      unity,
    );
    expect(dip?.points[0]?.time).toBe(4);
  });

  it("draws a mute region at its place on the timeline", () => {
    const dips = clipGainDips(
      [
        clip({
          source_start: 2,
          source_end: 12,
          mute_regions: [{ start_s: 5, end_s: 6 }] as never,
        }),
      ],
      unity,
    );
    expect(dips).toHaveLength(1);
    expect(dips[0]?.points[0]?.time).toBeCloseTo(3);
    expect(Math.min(...(dips[0]?.points.map((p) => p.gain) ?? []))).toBe(0);
  });

  it("drops the fade-out before a cut and the fade-in after it", () => {
    const left = clip({ id: "a", fade_out_ms: 300, timeline_end: 5 });
    const right = clip({
      id: "b",
      timeline_start: 5,
      timeline_end: 10,
      fade_in_ms: 300,
      join_in_mode: "cut",
      join_left_clip_id: "a",
    });
    expect(clipGainDips([left, right], unity)).toEqual([]);
  });

  it("leaves a crossfade join to the render's blend", () => {
    const left = clip({ id: "a", fade_out_ms: 300, timeline_end: 5 });
    const right = clip({
      id: "b",
      timeline_start: 5,
      timeline_end: 10,
      fade_in_ms: 300,
      join_in_mode: "crossfade",
      join_left_clip_id: "a",
      join_crossfade_ms: 200,
    });
    expect(clipGainDips([left, right], unity)).toEqual([]);
  });

  it("still draws the edge fades of a crossfade that does not blend", () => {
    const left = clip({ id: "a", fade_out_ms: 300, timeline_end: 5 });
    const right = clip({
      id: "b",
      timeline_start: 5,
      timeline_end: 10,
      fade_in_ms: 300,
      join_in_mode: "crossfade",
      join_left_clip_id: "a",
      join_crossfade_ms: 0,
      join_crossfade_blocked: "no_headroom",
    });
    expect(clipGainDips([left, right], unity)).toHaveLength(2);
  });

  it("draws the fade-in of a first clip even when it is set to crossfade", () => {
    const first = clip({ fade_in_ms: 300, join_in_mode: "crossfade" });
    expect(clipGainDips([first], unity)).toHaveLength(1);
  });

  it("draws a fade-in and a mute that start together as two dips", () => {
    const dips = clipGainDips(
      [
        clip({
          fade_in_ms: 500,
          mute_regions: [{ start_s: 0, end_s: 1 }] as never,
        }),
      ],
      unity,
    );
    expect(dips).toHaveLength(2);
    expect(dips[0]?.points[0]?.time).toBe(dips[1]?.points[0]?.time);
  });
});
