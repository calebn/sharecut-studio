import { describe, expect, it } from "vitest";
import {
  clampEnvelopeValue,
  envelopeValueAt,
  findVolumeEnvelope,
  replaceEnvelopePoint,
  sameEnvelopePoint,
  sameEnvelopePoints,
  sortedVolumePoints,
  withVolumeEnvelopePoints,
} from "./envelopes";

describe("envelopes", () => {
  const envelopes = [
    {
      track_id: "host",
      parameter: "volume",
      points: [
        { id: "late", time: 5, value: 0.5 },
        { id: "early", time: 0, value: 1 },
      ],
    },
  ];

  it("finds the volume envelope for a track", () => {
    expect(findVolumeEnvelope(envelopes, "host")?.parameter).toBe("volume");
    expect(findVolumeEnvelope(envelopes, "guest")).toBeUndefined();
  });

  it("returns points sorted by time", () => {
    expect(sortedVolumePoints(envelopes, "host")).toEqual([
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 5, value: 0.5 },
    ]);
  });

  it("sorts after replacing a point that changes order", () => {
    const points = replaceEnvelopePoint(
      [
        { id: "early", time: 0, value: 1 },
        { id: "late", time: 5, value: 0.5 },
      ],
      { id: "early", time: 8, value: 0.2 },
    );
    expect(points).toEqual([
      { id: "late", time: 5, value: 0.5 },
      { id: "early", time: 8, value: 0.2 },
    ]);
  });

  it("clamps envelope values to 0–1.5", () => {
    expect(clampEnvelopeValue(-1)).toBe(0);
    expect(clampEnvelopeValue(0.4)).toBe(0.4);
    expect(clampEnvelopeValue(9)).toBe(1.5);
  });

  it("preserves point identity when a point changes order", () => {
    const result = replaceEnvelopePoint(
      [
        { id: "early", time: 0, value: 1 },
        { id: "late", time: 5, value: 0.5 },
      ],
      { id: "early", time: 8, value: 0.2 },
    );
    expect(result[1]?.id).toBe("early");
  });

  it("evaluates empty, constant, held endpoints and stable coincident steps", () => {
    expect(envelopeValueAt([], 4)).toBe(1);
    expect(envelopeValueAt([{ id: "a", time: 5, value: 0.4 }], 0)).toBe(0.4);
    const tied = [
      { id: "a", time: 2, value: 1 },
      { id: "b", time: 4, value: 0.5 },
      { id: "c", time: 4, value: 0.2 },
    ];
    expect(envelopeValueAt(tied, 0)).toBe(1);
    expect(envelopeValueAt(tied, 3)).toBe(0.75);
    expect(envelopeValueAt(tied, 4)).toBe(0.2);
    expect(envelopeValueAt(tied, 20)).toBe(0.2);
    expect(sameEnvelopePoints(tied, [...tied].reverse())).toBe(false);
  });

  it("treats sub-epsilon float noise as the same point, not a new ID", () => {
    const a = { id: "p", time: 1, value: 0.5 };
    expect(sameEnvelopePoint(a, { ...a, value: 0.5 + 1e-9 })).toBe(true);
    expect(sameEnvelopePoint(a, { ...a, value: 0.25 })).toBe(false);
    expect(sameEnvelopePoint(a, { ...a, time: 2 })).toBe(false);
    expect(sameEnvelopePoint(a, { ...a, id: "q" })).toBe(false);
  });

  it("replaces only the volume envelope's points", () => {
    const pan = {
      track_id: "host",
      parameter: "pan",
      points: [{ id: "pan", time: 0, value: -1 }],
    };
    const next = [{ id: "new", time: 1, value: 1 }];
    expect(withVolumeEnvelopePoints([pan, ...envelopes], "host", next)).toEqual(
      [pan, { ...envelopes[0], points: next }],
    );
    expect(withVolumeEnvelopePoints([pan], "host", next)).toEqual([
      pan,
      { track_id: "host", parameter: "volume", points: next },
    ]);
  });
});

it("only recognizes the canonical volume parameter", () => {
  for (const parameter of ["gain", "", "pan"]) {
    expect(
      findVolumeEnvelope([{ track_id: "host", parameter, points: [] }], "host"),
    ).toBeUndefined();
  }
});
