import { describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../../test/fixtures";
import { compactTarget } from "./compactTarget";

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

describe("compactTarget", () => {
  it("names a fade or trim the router handed the press to, and locates its handle", () => {
    expect(
      compactTarget(project, selectClip, { kind: "fade-in", id: "c2" }),
    ).toEqual({
      title: "Fade in",
      locate: '[data-hit-kind="fade-in"][data-hit-id="c2"]',
    });
    expect(
      compactTarget(project, selectClip, { kind: "trim-out", id: "c2" }),
    ).toEqual({
      title: "Trim end",
      locate: '[data-hit-kind="trim-out"][data-hit-id="c2"]',
    });
  });

  it("falls back to the clip when the last press was its body or another clip's handle", () => {
    const body = { title: "Mira clip", locate: '[data-clip-id="c2"]' };
    expect(compactTarget(project, selectClip, null)).toEqual(body);
    expect(
      compactTarget(project, selectClip, { kind: "fade-in", id: "other" }),
    ).toEqual(body);
  });

  it("names a pending edit, an envelope point and a chapter, and locates each", () => {
    expect(
      compactTarget(
        project,
        { kind: "pending", id: "p1", trackId: "host" },
        null,
      ),
    ).toEqual({ title: "Pending remove", locate: '[data-pending-id="p1"]' });
    expect(
      compactTarget(
        project,
        { kind: "envelopePoint", trackId: "host", pointId: "e1" },
        null,
      ),
    ).toEqual({
      title: "Envelope point",
      locate: '[data-hit-kind="envelope-point"][data-hit-id="e1"]',
    });
    expect(
      compactTarget(project, { kind: "chapter", id: "ch1", time: 5 }, null),
    ).toMatchObject({
      title: "Chapter",
      locate: '[data-hit-kind="chapter"][data-hit-id="5-ch1"]',
    });
  });

  it("leaves selections that are not timeline targets, and targets that are gone, to the regular sheet", () => {
    expect(
      compactTarget(project, { kind: "track", trackId: "host" }, null),
    ).toBe(null);
    expect(compactTarget(project, null, null)).toBe(null);
    expect(
      compactTarget(
        project,
        { kind: "pending", id: "missing", trackId: "host" },
        null,
      ),
    ).toBe(null);
  });

  it("leaves a pending edit with no timeline bounds, a clip not in the project and a missing envelope point to the regular sheet", () => {
    const unplaced = minimalProject({
      pending_edits: [
        pendingEditView({
          id: "p2",
          track_id: "host",
          track_ids: ["host"],
          timeline_start: null,
          timeline_end: null,
        }),
      ],
      envelopes: [{ track_id: "host", parameter: "volume", points: [] }],
    });
    expect(
      compactTarget(
        unplaced,
        { kind: "pending", id: "p2", trackId: "host" },
        null,
      ),
    ).toBe(null);
    expect(
      compactTarget(
        project,
        { kind: "clip", id: "gone", trackId: "host" },
        null,
      ),
    ).toBe(null);
    expect(
      compactTarget(
        unplaced,
        { kind: "envelopePoint", trackId: "host", pointId: "e1" },
        null,
      ),
    ).toBe(null);
  });
});
