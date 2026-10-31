import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { inspectorHeading } from "./inspectorHeading";

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
  it("names one track by its label", () => {
    expect(
      inspectorHeading({ kind: "track", trackId: "host" }, project).name,
    ).toBe("Mira");
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
