import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { projectSourceDurationSec, timelineCut } from "./projectMedia";

const clip = (track_id: string, timeline_end: number): ClipRow => ({
  id: `${track_id}-${timeline_end}`,
  track_id,
  source_start: 0,
  source_end: timeline_end,
  timeline_start: 0,
  timeline_end,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
});

describe("timelineCut", () => {
  it("measures an uncut music bed past the edited dialogue on dialogue clips", () => {
    const cut = timelineCut(
      minimalProject({
        tracks: [
          sampleTrack({ id: "host", duration_sec: 600 }),
          sampleTrack({ id: "bed", role: "music", duration_sec: 900 }),
        ],
        clips: {
          tracks: { host: [clip("host", 500)], bed: [clip("bed", 900)] },
          clip_count: 2,
        },
        timeline_duration_sec: 900,
      }),
    );
    expect(cut).toEqual({ cutSec: 100, sourceSec: 600, timelineSec: 500 });
  });

  it("takes the latest clip end across dialogue tracks", () => {
    const cut = timelineCut(
      minimalProject({
        tracks: [
          sampleTrack({ id: "host", duration_sec: 600 }),
          sampleTrack({ id: "guest", duration_sec: 600 }),
        ],
        clips: {
          tracks: { host: [clip("host", 300)], guest: [clip("guest", 450)] },
          clip_count: 2,
        },
        timeline_duration_sec: 450,
      }),
    );
    expect(cut?.timelineSec).toBe(450);
    expect(cut?.cutSec).toBe(150);
  });

  it("uses timeline_duration_sec when no dialogue track has media", () => {
    const cut = timelineCut(
      minimalProject({
        tracks: [
          sampleTrack({ id: "host", duration_sec: null }),
          sampleTrack({ id: "bed", role: "music", duration_sec: 120 }),
        ],
        clips: { tracks: { bed: [clip("bed", 90)] }, clip_count: 1 },
        timeline_duration_sec: 100,
      }),
    );
    expect(cut?.timelineSec).toBe(100);
    expect(cut?.cutSec).toBe(20);
  });

  it("uses every track when no dialogue track has media", () => {
    const p = minimalProject({
      tracks: [
        sampleTrack({ id: "host", duration_sec: null }),
        sampleTrack({ id: "bed", role: "music", duration_sec: 120 }),
      ],
    });
    expect(projectSourceDurationSec(p)).toBe(120);
  });

  it("takes the longest dialogue track and treats null as 0", () => {
    const p = minimalProject({
      tracks: [
        sampleTrack({ duration_sec: 10 }),
        sampleTrack({ duration_sec: 30 }),
        sampleTrack({ duration_sec: null }),
      ],
    });
    expect(projectSourceDurationSec(p)).toBe(30);
  });

  it("is null without source media", () => {
    expect(timelineCut(minimalProject())).toBeNull();
    expect(
      timelineCut(
        minimalProject({ tracks: [sampleTrack({ duration_sec: null })] }),
      ),
    ).toBeNull();
  });

  it("is source minus timeline", () => {
    const cut = timelineCut(
      minimalProject({
        tracks: [sampleTrack({ duration_sec: 1689.4 })],
        timeline_duration_sec: 221.3,
      }),
    );
    expect(cut?.cutSec).toBeCloseTo(1468.1, 5);
  });

  it("clamps to 0 when the timeline is longer", () => {
    const cut = timelineCut(
      minimalProject({
        tracks: [sampleTrack({ duration_sec: 10 })],
        timeline_duration_sec: 50,
      }),
    );
    expect(cut?.cutSec).toBe(0);
  });
});
