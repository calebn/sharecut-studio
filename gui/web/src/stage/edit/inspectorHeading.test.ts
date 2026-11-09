import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { inspectorHeading, inspectorShortName } from "./inspectorHeading";

const project = minimalProject({
  tracks: [sampleTrack({ id: "host", label: "Mira" })],
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [
        { id: "late", time: 5, value: 1 },
        { id: "early", time: 2, value: 1 },
      ],
    },
  ],
});

describe("inspectorHeading for the volume envelope", () => {
  it("names a point by its place along the track", () => {
    expect(
      inspectorHeading(
        { kind: "envelopePoint", trackId: "host", pointId: "late" },
        project,
      ),
    ).toEqual({ icon: "volume-1", name: "Mira point 2" });
  });

  it("names a point that has gone without a number", () => {
    expect(
      inspectorHeading(
        { kind: "envelopePoint", trackId: "host", pointId: "gone" },
        project,
      ).name,
    ).toBe("Mira point");
  });

  it("heads the envelope itself as its track", () => {
    expect(
      inspectorHeading({ kind: "envelope", trackId: "host" }, project).name,
    ).toBe("Mira");
  });
});

describe("inspectorHeading for a track selection", () => {
  it("names one track by its label and marks it with its lane avatar", () => {
    const heading = inspectorHeading(
      { kind: "track", trackId: "host" },
      project,
    );
    expect(heading).toMatchObject({
      icon: "volume-1",
      name: "Mira",
      mark: { name: "Mira", colorIndex: 0 },
    });
    expect(heading.onRename).toBeTypeOf("function");
  });

  it("leaves a missing track unmarked and a multi-track selection on the icon", () => {
    expect(
      inspectorHeading({ kind: "track", trackId: "gone" }, project),
    ).toEqual({ icon: "volume-1", name: "gone" });
    expect(
      inspectorHeading(
        { kind: "track", trackId: "host", trackIds: ["host", "guest"] },
        project,
      ),
    ).toEqual({ icon: "volume-1", name: "2 tracks" });
  });

  it("counts a multi-track selection instead of naming one track", () => {
    expect(
      inspectorHeading(
        { kind: "track", trackId: "host", trackIds: ["host", "guest"] },
        project,
      ).name,
    ).toBe("2 tracks");
  });
});

describe("inspectorHeading for a clip", () => {
  it("keeps the range when the selection names another lane than the clip is on", () => {
    const withClip = minimalProject({
      tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
      clips: {
        tracks: {
          host: [
            {
              id: "c1",
              track_id: "host",
              source_start: 0,
              source_end: 2,
              timeline_start: 4,
              timeline_end: 6,
              fade_in_ms: 0,
              fade_out_ms: 0,
              join_in_mode: "fade",
              source_id: null,
              source_duration_sec: null,
              recording_key: null,
            },
          ],
        },
        clip_count: 1,
      },
    });
    expect(
      inspectorHeading({ kind: "clip", id: "c1", trackId: "stale" }, withClip)
        .name,
    ).toBe("Mira · 00:04.000 to 00:06.000");
  });
});

describe("inspectorShortName for the phone dock", () => {
  it("keeps a heading's name, and names a clip by its speaker alone", () => {
    expect(
      inspectorShortName(
        { kind: "envelopePoint", trackId: "host", pointId: "late" },
        project,
      ),
    ).toBe("Mira point 2");
    expect(
      inspectorShortName({ kind: "chapter", id: "A", time: 1 }, project),
    ).toBe("Chapter");
    expect(
      inspectorShortName(
        { kind: "clip", id: "gone", trackId: "host" },
        project,
      ),
    ).toBe("Mira clip");
  });
});
