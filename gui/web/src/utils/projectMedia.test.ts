import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { projectSourceDurationSec, timelineCut } from "./projectMedia";

describe("timelineCut", () => {
  it("takes the longest track and treats null as 0", () => {
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
