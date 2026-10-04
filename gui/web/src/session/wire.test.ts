import { describe, expect, it } from "vitest";
import { selectionFromWire, selectionToWire } from "./wire";

const envelopes = [
  {
    track_id: "host",
    parameter: "volume" as const,
    points: [
      { id: "a", time: 0, value: 1 },
      { id: "b", time: 4, value: 0.5 },
      { id: "c", time: 9, value: 0.2 },
    ],
  },
];

describe("selection wire", () => {
  it("sends a session-wide applied selection without a track id", () => {
    const local = { kind: "applied" as const, id: "alog_1" };
    const wire = selectionToWire(local);
    expect(wire).toStrictEqual({ kind: "applied", id: "alog_1" });
    expect(selectionFromWire(wire)).toStrictEqual(local);
  });

  it("round-trips an applied selection on a track", () => {
    const local = { kind: "applied" as const, id: "alog_1", trackId: "host" };
    const wire = selectionToWire(local);
    expect(wire).toStrictEqual({
      kind: "applied",
      id: "alog_1",
      track_id: "host",
    });
    expect(selectionFromWire(wire)).toStrictEqual(local);
  });

  it("round-trips transcriptWord", () => {
    const local = {
      kind: "transcriptWord" as const,
      trackId: "host",
      wordIndex: 12,
    };
    const wire = selectionToWire(local);
    expect(wire).toEqual({
      kind: "transcriptWord",
      track_id: "host",
      word_index: 12,
    });
    expect(selectionFromWire(wire)).toEqual(local);
  });

  it("round-trips transcriptRange", () => {
    const local = {
      kind: "transcriptRange" as const,
      trackId: "host",
      startWordIndex: 2,
      endWordIndex: 5,
    };
    const wire = selectionToWire(local);
    expect(wire).toEqual({
      kind: "transcriptRange",
      track_id: "host",
      word_index: 2,
      word_end: 5,
    });
    expect(selectionFromWire(wire)).toEqual(local);
  });

  it("round-trips envelopePoint by exact ID", () => {
    const local = {
      kind: "envelopePoint" as const,
      trackId: "host",
      pointId: "c",
    };
    const wire = selectionToWire(local, envelopes);
    expect(wire).toEqual({
      kind: "envelopePoint",
      track_id: "host",
      id: "c",
      time: 9,
    });
    expect(selectionFromWire(wire, envelopes)).toEqual(local);
  });
});

it("does not recover a missing point by matching or nearby time", () => {
  expect(
    selectionFromWire(
      { kind: "envelopePoint", track_id: "host", time: 4 },
      envelopes,
    ),
  ).toBeNull();
  expect(
    selectionFromWire(
      { kind: "envelopePoint", track_id: "host", id: "missing", time: 4 },
      envelopes,
    ),
  ).toBeNull();
});
it("keeps coincident points distinct and resolves current time by ID", () => {
  const tied = [
    {
      ...envelopes[0]!,
      points: [
        { id: "a", time: 4, value: 1 },
        { id: "b", time: 4, value: 0.5 },
      ],
    },
  ];
  expect(
    selectionFromWire(
      { kind: "envelopePoint", track_id: "host", id: "b", time: 100 },
      tied,
    ),
  ).toEqual({ kind: "envelopePoint", trackId: "host", pointId: "b" });
});
it("projects the local workspace as track presence without creating a point", () => {
  expect(selectionToWire({ kind: "envelope", trackId: "host" }, [])).toEqual({
    kind: "track",
    track_id: "host",
  });
});
