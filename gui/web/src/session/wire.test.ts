import { describe, expect, it } from "vitest";
import {
  appliedEditRecord,
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import { selectionFromWire, selectionToWire, wireSelectionPatch } from "./wire";

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

const project = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  envelopes,
  applied_edits: {
    count: 1,
    records: [appliedEditRecord({ id: "alog_1" })],
  },
  pending_edits: [pendingEditView({ id: "cut_1", track_id: "host" })],
  comments: [sampleComment({ id: "c1" })],
});

describe("selection wire", () => {
  it("keeps automatic reduction selections local and rejects them from the wire", () => {
    expect(
      selectionToWire({
        kind: "bleedAttenuation",
        id: "clip-1",
        trackId: "host",
        regionKey: "local-region",
      }),
    ).toBeNull();
    const wire = { kind: "bleedAttenuation", id: "clip-1", track_id: "host" };
    expect(selectionFromWire(wire, project)).toBeNull();
    expect(wireSelectionPatch(wire, project)).toEqual({
      selection: null,
      pendingWireSelection: null,
    });
  });
  it("sends a session-wide applied selection without a track id", () => {
    const local = { kind: "applied" as const, id: "alog_1" };
    const wire = selectionToWire(local);
    expect(wire).toStrictEqual({ kind: "applied", id: "alog_1" });
    expect(selectionFromWire(wire, project)).toStrictEqual(local);
  });

  it("round-trips an applied selection on a track", () => {
    const local = { kind: "applied" as const, id: "alog_1", trackId: "host" };
    const wire = selectionToWire(local);
    expect(wire).toStrictEqual({
      kind: "applied",
      id: "alog_1",
      track_id: "host",
    });
    expect(selectionFromWire(wire, project)).toStrictEqual(local);
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
    expect(selectionFromWire(wire, project)).toEqual(local);
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
    expect(selectionFromWire(wire, project)).toEqual(local);
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
    expect(selectionFromWire(wire, project)).toEqual(local);
  });

  it("keeps a pending edit and a comment that the project still has", () => {
    expect(
      selectionFromWire(
        { kind: "pending", id: "cut_1", track_id: "host" },
        project,
      ),
    ).toEqual({ kind: "pending", id: "cut_1", trackId: "host" });
    expect(selectionFromWire({ kind: "comment", id: "c1" }, project)).toEqual({
      kind: "comment",
      id: "c1",
    });
  });

  it("drops a selection whose target is gone from the project", () => {
    expect(
      selectionFromWire(
        { kind: "pending", id: "cut_gone", track_id: "host" },
        project,
      ),
    ).toBeNull();
    expect(
      selectionFromWire({ kind: "comment", id: "c_gone" }, project),
    ).toBeNull();
    expect(
      selectionFromWire({ kind: "applied", id: "alog_gone" }, project),
    ).toBeNull();
    expect(
      selectionFromWire({ kind: "clip", id: "g9", track_id: "host" }, project),
    ).toBeNull();
    expect(
      selectionFromWire({ kind: "track", track_id: "guest" }, project),
    ).toBeNull();
  });

  it("holds a wire selection pending before the project has loaded", () => {
    const wire = { kind: "pending" as const, id: "cut_1", track_id: "host" };
    expect(selectionFromWire(wire, null)).toBeNull();
    expect(wireSelectionPatch(wire, null)).toEqual({
      selection: null,
      pendingWireSelection: wire,
    });
  });

  it("holds nothing pending once the selection resolves or is cleared", () => {
    const wire = { kind: "pending" as const, id: "cut_1", track_id: "host" };
    expect(wireSelectionPatch(wire, project)).toEqual({
      selection: { kind: "pending", id: "cut_1", trackId: "host" },
      pendingWireSelection: null,
    });
    expect(wireSelectionPatch(null, null).pendingWireSelection).toBe(null);
  });
});

it("does not recover a missing point by matching or nearby time", () => {
  expect(
    selectionFromWire(
      { kind: "envelopePoint", track_id: "host", time: 4 },
      project,
    ),
  ).toBeNull();
  expect(
    selectionFromWire(
      { kind: "envelopePoint", track_id: "host", id: "missing", time: 4 },
      project,
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
      { ...project, envelopes: tied },
    ),
  ).toEqual({ kind: "envelopePoint", trackId: "host", pointId: "b" });
});
it("projects the local workspace as track presence without creating a point", () => {
  expect(selectionToWire({ kind: "envelope", trackId: "host" }, [])).toEqual({
    kind: "track",
    track_id: "host",
  });
});
