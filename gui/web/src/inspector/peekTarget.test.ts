import { describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../test/fixtures";
import { peekTarget } from "./peekTarget";

const clip = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 10,
  source_end: 40,
  timeline_start: 10,
  timeline_end: 40,
  fade_in_ms: 300,
});
const project = minimalProject({
  tracks: [sampleTrack({ id: "host", speaker: "Mira" })],
  clips: { tracks: { host: [clip] }, clip_count: 1 },
  pending_edits: [
    pendingEditView({
      id: "p1",
      track_id: "host",
      track_ids: ["host"],
      source_start: 20,
      source_end: 24,
      source_start_timeline: 20,
      source_end_timeline: 24,
      timeline_start: 20,
      timeline_end: 24,
      timeline_spans: [{ start: 20, end: 24 }],
    }),
    pendingEditView({ id: "s1", track_id: "host", type: "split" }),
  ],
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [{ id: "e1", time: 16, value: 0.8 }],
    },
  ],
});
const selectClip = { kind: "clip", id: "c2", trackId: "host" } as const;

describe("peekTarget", () => {
  it("names a fade the router handed the press to, with its value and one nudge row", () => {
    expect(
      peekTarget(project, selectClip, { kind: "fade-in", id: "c2" }),
    ).toEqual({
      title: "Fade in",
      owner: "Mira clip",
      value: "300 ms",
      nudges: [
        {
          field: { kind: "fade", edge: "in", trackId: "host", clipId: "c2" },
          label: null,
          name: "Fade in",
        },
      ],
      locate: '[data-hit-kind="fade-in"][data-hit-id="c2"]',
    });
  });

  it("names a trim by its source time", () => {
    expect(
      peekTarget(project, selectClip, { kind: "trim-out", id: "c2" }),
    ).toMatchObject({
      title: "Trim end",
      value: "00:40.000",
      nudges: [{ field: { kind: "trim", edge: "out" }, name: "Trim end" }],
    });
  });

  it("falls back to the clip when the last press was its body or another clip's handle", () => {
    const body = {
      title: "Mira clip",
      owner: null,
      value: "00:10.000 to 00:40.000",
      nudges: [],
      locate: '[data-clip-id="c2"]',
    };
    expect(peekTarget(project, selectClip, null)).toEqual(body);
    expect(
      peekTarget(project, selectClip, { kind: "fade-in", id: "other" }),
    ).toEqual(body);
  });

  it("gives a pending edit start and end rows, and an envelope point time and level rows", () => {
    const pending = peekTarget(
      project,
      { kind: "pending", id: "p1", trackId: "host" },
      null,
    );
    expect(pending).toMatchObject({
      title: "Pending remove",
      owner: "host",
      value: "00:20.000 to 00:24.000",
      locate: '[data-pending-id="p1"]',
    });
    expect(pending?.nudges.map((n) => [n.label, n.name])).toEqual([
      ["Start", "Pending remove start"],
      ["End", "Pending remove end"],
    ]);
    const point = peekTarget(
      project,
      { kind: "envelopePoint", trackId: "host", pointId: "e1" },
      null,
    );
    expect(point).toMatchObject({
      title: "Envelope point",
      value: "0.80× at 00:16.000",
    });
    expect(point?.nudges.map((n) => [n.field.kind, n.label, n.name])).toEqual([
      ["envelope-time", "Time", "Envelope point"],
      ["envelope-level", "Level", "Envelope point level"],
    ]);
  });

  it("gives a pending split no nudges", () => {
    expect(
      peekTarget(project, { kind: "pending", id: "s1", trackId: "host" }, null)
        ?.nudges,
    ).toEqual([]);
  });

  it("leaves selections that are not timeline targets to the full inspector", () => {
    expect(peekTarget(project, { kind: "track", trackId: "host" }, null)).toBe(
      null,
    );
    expect(peekTarget(project, null, null)).toBe(null);
  });
});
