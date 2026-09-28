import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type {
  AppliedEditRecord,
  AutomationEnvelope,
  ClipRow,
  PendingEditView,
  ProjectView,
} from "../types/project";
import { mergeProjectPatch, projectFromDocumentSnapshot } from "./projectPatch";
import { reuseUnchanged, sameItems } from "./reuseUnchanged";

function clip(
  id: string,
  start: number,
  extra: Partial<ClipRow> = {},
): ClipRow {
  return {
    id,
    track_id: "host",
    source_start: start,
    source_end: start + 1,
    timeline_start: start,
    timeline_end: start + 1,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...extra,
  };
}

function project(): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      tracks: {
        host: [
          clip("a", 0, { mute_regions: [{ start_s: 0.1, end_s: 0.2 }] }),
          clip("b", 1),
        ],
        guest: [clip("c", 0, { track_id: "guest" })],
      },
      clip_count: 3,
    },
  });
}

/** A deep copy, as a fresh server projection arrives. */
function fresh(p: ProjectView): ProjectView {
  return structuredClone(p);
}

describe("reuseUnchanged", () => {
  it("takes a changed clips field other than the lanes", () => {
    const prev = project();
    const next = fresh(prev);
    (next.clips as unknown as Record<string, unknown>).gap_sec = 2;
    const out = reuseUnchanged(prev, next);
    expect(out.clips).not.toBe(prev.clips);
    expect((out.clips as unknown as Record<string, unknown>).gap_sec).toBe(2);
    expect(out.clips.tracks).toBe(prev.clips.tracks);
  });

  it("returns next when there is no previous projection", () => {
    const next = project();
    expect(reuseUnchanged(null, next)).toBe(next);
  });

  it("reuses tracks, lanes and clips of an equal projection", () => {
    const prev = project();
    const out = reuseUnchanged(prev, fresh(prev));
    expect(out.tracks).toBe(prev.tracks);
    expect(out.clips).toBe(prev.clips);
  });

  it("replaces only the changed clip; its lane is new, others are kept", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.host![1] = {
      ...next.clips.tracks.host![1]!,
      fade_in_ms: 20,
    };
    const out = reuseUnchanged(prev, next);
    const host = out.clips.tracks.host!;
    expect(host).not.toBe(prev.clips.tracks.host);
    expect(host[0]).toBe(prev.clips.tracks.host![0]);
    expect(host[1]).not.toBe(prev.clips.tracks.host![1]);
    expect(host[1]!.fade_in_ms).toBe(20);
    expect(out.clips.tracks.guest).toBe(prev.clips.tracks.guest);
    expect(out.tracks).toBe(prev.tracks);
  });

  it("compares mute regions element by element", () => {
    const prev = project();
    const same = fresh(prev);
    expect(reuseUnchanged(prev, same).clips.tracks.host![0]).toBe(
      prev.clips.tracks.host![0],
    );
    const moved = fresh(prev);
    moved.clips.tracks.host![0]!.mute_regions = [{ start_s: 0.1, end_s: 0.3 }];
    expect(reuseUnchanged(prev, moved).clips.tracks.host![0]).not.toBe(
      prev.clips.tracks.host![0],
    );
  });

  it("compares clipping regions element by element", () => {
    const prev = project();
    prev.clips.tracks.host![1]!.clipping_regions = [{ start_s: 1, end_s: 2 }];
    const same = fresh(prev);
    expect(reuseUnchanged(prev, same).clips.tracks.host![1]).toBe(
      prev.clips.tracks.host![1],
    );
    const moved = fresh(prev);
    moved.clips.tracks.host![1]!.clipping_regions = [{ start_s: 1, end_s: 3 }];
    expect(reuseUnchanged(prev, moved).clips.tracks.host![1]).not.toBe(
      prev.clips.tracks.host![1],
    );
  });

  it("keeps an unchanged track by id when another track changes", () => {
    const prev = project();
    const next = fresh(prev);
    next.tracks[1] = { ...next.tracks[1]!, muted: true };
    const out = reuseUnchanged(prev, next);
    expect(out.tracks).not.toBe(prev.tracks);
    expect(out.tracks[0]).toBe(prev.tracks[0]);
    expect(out.tracks[1]!.muted).toBe(true);
  });

  it("builds a new array when items are reordered", () => {
    const prev = project();
    const next = fresh(prev);
    next.tracks.reverse();
    const out = reuseUnchanged(prev, next);
    expect(out.tracks).not.toBe(prev.tracks);
    expect(out.tracks[0]).toBe(prev.tracks[1]);
    expect(out.tracks[1]).toBe(prev.tracks[0]);
  });

  it("does not reuse a clip whose keys differ", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.guest![0] = {
      ...next.clips.tracks.guest![0]!,
      origin_track_id: "host",
    };
    const out = reuseUnchanged(prev, next);
    expect(out.clips.tracks.guest![0]).not.toBe(prev.clips.tracks.guest![0]);
    expect(out.clips.tracks.host).toBe(prev.clips.tracks.host);
  });

  it("keeps new lanes and a changed clip count", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.extra = [clip("d", 0, { track_id: "extra" })];
    next.clips.clip_count = 4;
    const out = reuseUnchanged(prev, next);
    expect(out.clips).not.toBe(prev.clips);
    expect(out.clips.clip_count).toBe(4);
    expect(out.clips.tracks.host).toBe(prev.clips.tracks.host);
    expect(out.clips.tracks.extra).toBe(next.clips.tracks.extra);
  });

  it("runs on document snapshots and projection patches", () => {
    const prev = project();
    const snap = projectFromDocumentSnapshot(prev, { project: fresh(prev) });
    expect(snap?.clips).toBe(prev.clips);
    expect(snap?.tracks).toBe(prev.tracks);
    const patched = mergeProjectPatch(prev, {
      clips: fresh(prev).clips,
      tracks: fresh(prev).tracks,
    });
    expect(patched.clips).toBe(prev.clips);
    expect(patched.tracks).toBe(prev.tracks);
    const viaPatch = projectFromDocumentSnapshot(prev, {
      patch: { clips: fresh(prev).clips },
    });
    expect(viaPatch?.clips).toBe(prev.clips);
  });

  function envelope(
    trackId: string,
    parameter: string,
    points: AutomationEnvelope["points"] = [],
  ): AutomationEnvelope {
    return { track_id: trackId, parameter, points };
  }

  function pendingEdit(
    id: string,
    extra: Partial<PendingEditView> = {},
  ): PendingEditView {
    return {
      id,
      track_id: "host",
      type: "cut",
      reason: null,
      source_start: 0,
      source_end: 1,
      timeline_start: 0,
      timeline_end: 1,
      timeline_spans: [],
      mappable: true,
      crossfade_ms: null,
      boundary_mode: null,
      cut_confidence: null,
      review_required: false,
      applied: false,
      ...extra,
    };
  }

  function appliedRecord(
    id: string,
    extra: Partial<AppliedEditRecord> = {},
  ): AppliedEditRecord {
    return {
      id,
      applied_at: "2024-01-01T00:00:00Z",
      operation: "cut",
      track_ids: ["host"],
      timeline_start: 0,
      timeline_end: 1,
      source_start: 0,
      source_end: 1,
      reason: null,
      params: {},
      ...extra,
    };
  }

  it("reuses envelopes, pending edits and applied records of an equal projection", () => {
    const prev = minimalProject({
      envelopes: [envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }])],
      pending_edits: [pendingEdit("pe1")],
      applied_edits: { count: 1, records: [appliedRecord("ar1")] },
    });
    const out = reuseUnchanged(prev, fresh(prev));
    expect(out.envelopes).toBe(prev.envelopes);
    expect(out.pending_edits).toBe(prev.pending_edits);
    expect(out.applied_edits).toBe(prev.applied_edits);
  });

  it("reuses an envelope whose points are equal by value (envelopes have no id)", () => {
    const prev = minimalProject({
      envelopes: [envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }])],
    });
    const next = fresh(prev);
    next.envelopes = [
      envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }]),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes).toBe(prev.envelopes);
    expect(out.envelopes[0]).toBe(prev.envelopes[0]);
  });

  it("does not reuse an envelope whose points changed", () => {
    const prev = minimalProject({
      envelopes: [envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }])],
    });
    const next = fresh(prev);
    next.envelopes = [
      envelope("host", "gain", [{ id: "p1", time: 0, value: 0.5 }]),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes).not.toBe(prev.envelopes);
    expect(out.envelopes[0]).not.toBe(prev.envelopes[0]);
  });

  it("reuses an envelope whose points differ only in key order", () => {
    const prev = minimalProject({
      envelopes: [envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }])],
    });
    const next = fresh(prev);
    next.envelopes = [
      envelope("host", "gain", [{ value: 1, time: 0, id: "p1" }]),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes[0]).toBe(prev.envelopes[0]);
  });

  it("does not reuse an envelope whose point gained a field", () => {
    const prev = minimalProject({
      envelopes: [envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }])],
    });
    const next = fresh(prev);
    next.envelopes = [
      envelope("host", "gain", [
        {
          id: "p1",
          time: 0,
          value: 1,
          curve: "linear",
        } as unknown as AutomationEnvelope["points"][number],
      ]),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes[0]).not.toBe(prev.envelopes[0]);
  });

  it("swaps an envelope keyed by track_id + parameter, keeping the other", () => {
    const prev = minimalProject({
      envelopes: [
        envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }]),
        envelope("guest", "gain", [{ id: "p2", time: 0, value: 1 }]),
      ],
    });
    const next = fresh(prev);
    next.envelopes = [
      prev.envelopes[0]!,
      envelope("guest", "pan", [{ id: "p3", time: 0, value: 0 }]),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes).not.toBe(prev.envelopes);
    expect(out.envelopes[0]).toBe(prev.envelopes[0]);
    expect(out.envelopes[1]).toBe(next.envelopes[1]);
  });

  it("keeps every envelope, losing only reuse, when two share track_id + parameter", () => {
    const prev = minimalProject({
      envelopes: [
        envelope("host", "gain", [{ id: "p1", time: 0, value: 1 }]),
        envelope("host", "gain", [{ id: "p2", time: 1, value: 0.5 }]),
      ],
    });
    const next = fresh(prev);
    const out = reuseUnchanged(prev, next);
    expect(out.envelopes).toEqual(next.envelopes);
    expect(out.envelopes[0]).toBe(next.envelopes[0]);
    expect(out.envelopes[1]).toBe(prev.envelopes[1]);
  });

  it("reuses a pending edit whose timeline_spans/track_ids changed only by value", () => {
    const prev = minimalProject({
      pending_edits: [
        pendingEdit("pe1", {
          track_ids: ["host"],
          timeline_spans: [{ start: 0, end: 1 }],
        }),
      ],
    });
    const next = fresh(prev);
    next.pending_edits = [
      pendingEdit("pe1", {
        track_ids: ["host"],
        timeline_spans: [{ start: 0, end: 1 }],
      }),
    ];
    const out = reuseUnchanged(prev, next);
    expect(out.pending_edits).toBe(prev.pending_edits);
  });

  it("adds a pending edit record while keeping the existing one", () => {
    const prev = minimalProject({ pending_edits: [pendingEdit("pe1")] });
    const next = fresh(prev);
    next.pending_edits = [prev.pending_edits[0]!, pendingEdit("pe2")];
    const out = reuseUnchanged(prev, next);
    expect(out.pending_edits).not.toBe(prev.pending_edits);
    expect(out.pending_edits[0]).toBe(prev.pending_edits[0]);
    expect(out.pending_edits[1]).toBe(next.pending_edits[1]);
  });

  it("reuses an applied record whose params changed only by value", () => {
    const prev = minimalProject({
      applied_edits: {
        count: 1,
        records: [appliedRecord("ar1", { params: { db: 1 } })],
      },
    });
    const next = fresh(prev);
    next.applied_edits = {
      count: 1,
      records: [appliedRecord("ar1", { params: { db: 1 } })],
    };
    const out = reuseUnchanged(prev, next);
    expect(out.applied_edits).toBe(prev.applied_edits);
  });

  it("keeps the applied_edits object when only count changes but records match", () => {
    const prev = minimalProject({
      applied_edits: { count: 1, records: [appliedRecord("ar1")] },
    });
    const next = fresh(prev);
    next.applied_edits = {
      count: 2,
      records: [appliedRecord("ar1")],
    };
    const out = reuseUnchanged(prev, next);
    expect(out.applied_edits).not.toBe(prev.applied_edits);
    expect(out.applied_edits.count).toBe(2);
    expect(out.applied_edits.records).toBe(prev.applied_edits.records);
  });

  it("does not reuse an applied record whose params changed", () => {
    const prev = minimalProject({
      applied_edits: {
        count: 1,
        records: [appliedRecord("ar1", { params: { db: 1 } })],
      },
    });
    const next = fresh(prev);
    next.applied_edits = {
      count: 1,
      records: [appliedRecord("ar1", { params: { db: 2 } })],
    };
    const out = reuseUnchanged(prev, next);
    expect(out.applied_edits).not.toBe(prev.applied_edits);
    expect(out.applied_edits.records[0]).not.toBe(
      prev.applied_edits.records[0],
    );
  });
});

describe("sameItems", () => {
  it("is true for the same array and for equal items in order", () => {
    const a = [1, 2, 3];
    expect(sameItems(a, a)).toBe(true);
    expect(sameItems([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameItems([], [])).toBe(true);
  });

  it("is false for a different length, item or order", () => {
    expect(sameItems([1, 2], [1, 2, 3])).toBe(false);
    expect(sameItems([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(sameItems([1, 2], [2, 1])).toBe(false);
  });

  it("compares items with the given equality", () => {
    const byX = (p: { x: number }, q: { x: number }) => p.x === q.x;
    expect(sameItems([{ x: 1 }], [{ x: 1 }])).toBe(false);
    expect(sameItems([{ x: 1 }], [{ x: 1 }], byX)).toBe(true);
  });
});
