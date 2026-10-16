import { describe, expect, it } from "vitest";
import {
  addVolumePoint,
  clampEnvelopeValue,
  envelopeValueAt,
  findVolumeEnvelope,
  flatEnvelopeLevel,
  replaceEnvelopePoint,
  sameEnvelopePoint,
  sameEnvelopePoints,
  setFlatEnvelopeLevel,
  sortedVolumePoints,
  volumeEnvelopeDbAt,
  withVolumeEnvelopePoints,
} from "./envelopes";

describe("envelopes", () => {
  it("classifies exact flatness and preserves raw point identity and order", () => {
    const raw = [
      { id: "late", time: 5, value: 0.6 },
      { id: "early", time: 0, value: 0.6 },
    ];
    expect(flatEnvelopeLevel([])).toBe(1);
    expect(flatEnvelopeLevel(raw)).toBe(0.6);
    expect(
      flatEnvelopeLevel([{ ...raw[0]!, value: 0.6000001 }, raw[1]!]),
    ).toBeNull();
    expect(
      setFlatEnvelopeLevel(raw, 0.4, 10, { start: "x", end: "y" }),
    ).toEqual([
      { id: "late", time: 5, value: 0.4 },
      { id: "early", time: 0, value: 0.4 },
    ]);
    expect(setFlatEnvelopeLevel([], 0.4, 10, { start: "x", end: "y" })).toEqual(
      [
        { id: "x", time: 0, value: 0.4 },
        { id: "y", time: 10, value: 0.4 },
      ],
    );
    expect(setFlatEnvelopeLevel([], 0.4, 0, { start: "x", end: "y" })).toEqual([
      { id: "x", time: 0, value: 0.4 },
    ]);
  });
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

  it("builds a flat first envelope point with stable endpoint identities", () => {
    const ids = { start: "start", end: "end" };
    expect(
      addVolumePoint([], { id: "new", time: 4, value: 0.4 }, 10, ids),
    ).toEqual([
      { id: "start", time: 0, value: 1 },
      { id: "new", time: 4, value: 0.4 },
      { id: "end", time: 10, value: 1 },
    ]);
    expect(
      addVolumePoint([], { id: "new", time: 0, value: 0.7 }, 10, ids),
    ).toEqual([
      { id: "new", time: 0, value: 0.7 },
      { id: "end", time: 10, value: 1 },
    ]);
    expect(
      addVolumePoint([], { id: "new", time: 5e-7, value: 0.7 }, 10, ids),
    ).toEqual([
      { id: "new", time: 0, value: 0.7 },
      { id: "end", time: 10, value: 1 },
    ]);
    expect(
      addVolumePoint([], { id: "new", time: 10 - 5e-7, value: 0.8 }, 10, ids),
    ).toEqual([
      { id: "start", time: 0, value: 1 },
      { id: "new", time: 10, value: 0.8 },
    ]);
  });

  it("keeps the prior empty-curve level at the endpoint anchors", () => {
    const first = addVolumePoint([], { id: "new", time: 5, value: 0.5 }, 10, {
      start: "start",
      end: "end",
    });
    expect(first).toEqual([
      { id: "start", time: 0, value: 1 },
      { id: "new", time: 5, value: 0.5 },
      { id: "end", time: 10, value: 1 },
    ]);
    expect(
      replaceEnvelopePoint(first, { id: "new", time: 5, value: 0.25 }),
    ).toEqual([
      { id: "start", time: 0, value: 1 },
      { id: "new", time: 5, value: 0.25 },
      { id: "end", time: 10, value: 1 },
    ]);
  });

  it("keeps distinct positive-duration anchors below the collision epsilon", () => {
    expect(
      addVolumePoint([], { id: "new", time: 2e-7, value: 0.3 }, 5e-7, {
        start: "start",
        end: "end",
      }),
    ).toEqual([
      { id: "new", time: 0, value: 0.3 },
      { id: "end", time: 5e-7, value: 1 },
    ]);
    expect(
      addVolumePoint([], { id: "new", time: 0, value: 0.3 }, 0, {
        start: "start",
        end: "end",
      }),
    ).toEqual([{ id: "new", time: 0, value: 0.3 }]);
  });

  it("adds a tied endpoint point on the nearer boundary and leaves existing curves unchanged apart from insertion", () => {
    expect(
      addVolumePoint([], { id: "new", time: 0.5e-6, value: 0.3 }, 1e-6, {
        start: "start",
        end: "end",
      }),
    ).toEqual([
      { id: "new", time: 0, value: 0.3 },
      { id: "end", time: 1e-6, value: 1 },
    ]);
    expect(
      addVolumePoint(
        [{ id: "late", time: 5, value: 0.5 }],
        { id: "new", time: 2, value: 0.8 },
        10,
        { start: "start", end: "end" },
      ),
    ).toEqual([
      { id: "new", time: 2, value: 0.8 },
      { id: "late", time: 5, value: 0.5 },
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

describe("volumeEnvelopeDbAt", () => {
  const envelopes = [
    {
      track_id: "host",
      parameter: "volume",
      points: [
        { id: "a", time: 0, value: 1 },
        { id: "b", time: 10, value: 0.5 },
        { id: "c", time: 20, value: 0 },
      ],
    },
    { track_id: "pan-only", parameter: "pan", points: [] },
  ];

  it("reads unity as 0 dB, attenuation as negative dB and silence as -Infinity", () => {
    expect(volumeEnvelopeDbAt(envelopes, "host", 0)).toBe(0);
    expect(volumeEnvelopeDbAt(envelopes, "host", 10)).toBeCloseTo(-6.02, 2);
    expect(volumeEnvelopeDbAt(envelopes, "host", 20)).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it("follows the playhead between points", () => {
    expect(volumeEnvelopeDbAt(envelopes, "host", 5)).toBeCloseTo(-2.5, 1);
  });

  it("is null when the track has no volume envelope points", () => {
    expect(volumeEnvelopeDbAt(envelopes, "guest", 3)).toBeNull();
    expect(volumeEnvelopeDbAt(envelopes, "pan-only", 3)).toBeNull();
    expect(volumeEnvelopeDbAt(undefined, "host", 3)).toBeNull();
    expect(
      volumeEnvelopeDbAt(
        [{ track_id: "host", parameter: "volume", points: [] }],
        "host",
        3,
      ),
    ).toBeNull();
  });
});
