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
      timeline_start: 20,
      timeline_end: 24,
    }),
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
  it("names a fade the router handed the press to, with its value and the keyboard's steps", () => {
    expect(
      peekTarget(project, selectClip, { kind: "fade-in", id: "c2" }),
    ).toMatchObject({
      title: "Fade in",
      owner: "Mira clip",
      value: "300 ms",
      nudge: { kind: "fade", edge: "in", steps: [1, 10], unit: "ms" },
      locate: '[data-hit-kind="fade-in"][data-hit-id="c2"]',
    });
  });

  it("names a trim by its source time, stepping 0.01 s and 0.1 s", () => {
    expect(
      peekTarget(project, selectClip, { kind: "trim-out", id: "c2" }),
    ).toMatchObject({
      title: "Trim end",
      value: "00:40.000",
      nudge: { kind: "trim", edge: "out", steps: [0.01, 0.1], unit: "s" },
    });
  });

  it("falls back to the clip when the last press was its body or another clip's handle", () => {
    const body = {
      title: "Mira clip",
      owner: null,
      value: "00:10.000 to 00:40.000",
      nudge: null,
      locate: '[data-clip-id="c2"]',
    };
    expect(peekTarget(project, selectClip, null)).toEqual(body);
    expect(
      peekTarget(project, selectClip, { kind: "fade-in", id: "other" }),
    ).toEqual(body);
  });

  it("shows a pending edit's span and an envelope point's gain", () => {
    expect(
      peekTarget(project, { kind: "pending", id: "p1", trackId: "host" }, null),
    ).toEqual({
      title: "Pending remove",
      owner: "host",
      value: "00:20.000 to 00:24.000",
      nudge: null,
      locate: '[data-pending-id="p1"]',
    });
    expect(
      peekTarget(
        project,
        { kind: "envelopePoint", trackId: "host", pointId: "e1" },
        null,
      ),
    ).toMatchObject({ title: "Envelope point", value: "0.80× at 00:16.000" });
  });

  it("leaves selections that are not timeline targets to the full inspector", () => {
    expect(peekTarget(project, { kind: "track", trackId: "host" }, null)).toBe(
      null,
    );
    expect(peekTarget(project, null, null)).toBe(null);
  });
});
