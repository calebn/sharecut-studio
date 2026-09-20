import { describe, expect, it } from "vitest";
import {
  clampEnvelopeValue,
  findVolumeEnvelope,
  indexOfVolumePointAtTime,
  replaceEnvelopePoint,
  sortedVolumePoints,
} from "./envelopes";

describe("envelopes", () => {
  const envelopes = [
    {
      track_id: "host",
      parameter: "volume",
      points: [
        { time: 5, value: 0.5 },
        { time: 0, value: 1 },
      ],
    },
  ];

  it("finds the volume envelope for a track", () => {
    expect(findVolumeEnvelope(envelopes, "host")?.parameter).toBe("volume");
    expect(findVolumeEnvelope(envelopes, "guest")).toBeUndefined();
  });

  it("returns points sorted by time", () => {
    expect(sortedVolumePoints(envelopes, "host")).toEqual([
      { time: 0, value: 1 },
      { time: 5, value: 0.5 },
    ]);
  });

  it("reindexes after replacing a point that changes order", () => {
    const { points, index } = replaceEnvelopePoint(
      [
        { time: 0, value: 1 },
        { time: 5, value: 0.5 },
      ],
      0,
      { time: 8, value: 0.2 },
    );
    expect(points).toEqual([
      { time: 5, value: 0.5 },
      { time: 8, value: 0.2 },
    ]);
    expect(index).toBe(1);
  });

  it("clamps envelope values to 0–1.5", () => {
    expect(clampEnvelopeValue(-1)).toBe(0);
    expect(clampEnvelopeValue(0.4)).toBe(0.4);
    expect(clampEnvelopeValue(9)).toBe(1.5);
  });

  it("finds the nearest volume point by time", () => {
    expect(indexOfVolumePointAtTime(envelopes, "host", 4.9)).toBe(1);
    expect(indexOfVolumePointAtTime(envelopes, "host", 0.1)).toBe(0);
    expect(indexOfVolumePointAtTime(envelopes, "guest", 0)).toBe(-1);
  });
});
