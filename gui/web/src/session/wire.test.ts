import { describe, expect, it } from "vitest";
import { selectionFromWire, selectionToWire } from "./wire";

const envelopes = [
  {
    track_id: "host",
    parameter: "volume" as const,
    points: [
      { time: 0, value: 1 },
      { time: 4, value: 0.5 },
      { time: 9, value: 0.2 },
    ],
  },
];

describe("selection wire", () => {
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

  it("round-trips envelopePoint by time", () => {
    const local = {
      kind: "envelopePoint" as const,
      trackId: "host",
      index: 2,
    };
    const wire = selectionToWire(local, envelopes);
    expect(wire).toEqual({
      kind: "envelopePoint",
      track_id: "host",
      time: 9,
    });
    expect(selectionFromWire(wire, envelopes)).toEqual(local);
  });
});
