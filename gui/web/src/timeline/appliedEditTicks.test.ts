import { describe, expect, it } from "vitest";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import {
  appliedEditTicks,
  appliedEditTitle,
  appliedRecordOnTimeline,
} from "./appliedEditTicks";

const TRACK = "mira-voice";

describe("appliedEditTicks", () => {
  it("projects two stacked ripples plus a trim onto the post-edit seams, zero width", () => {
    const clips = [
      clipRow({
        id: "c1",
        source_start: 0,
        source_end: 5,
        timeline_start: 0,
        timeline_end: 5,
      }),
      clipRow({
        id: "c2",
        source_start: 15,
        source_end: 40,
        timeline_start: 5,
        timeline_end: 30,
      }),
      clipRow({
        id: "c3",
        source_start: 50,
        source_end: 58,
        timeline_start: 30,
        timeline_end: 38,
      }),
    ];
    const rippleA = appliedEditRecord({
      id: "ripple-a",
      operation: "ripple_delete",
      timeline_start: 40,
      timeline_end: 50,
      source_start: null,
      source_end: null,
      params: { per_track_source: { [TRACK]: [40, 50] } },
    });
    const rippleB = appliedEditRecord({
      id: "ripple-b",
      operation: "ripple_delete",
      timeline_start: 5,
      timeline_end: 15,
      source_start: null,
      source_end: null,
      params: { per_track_source: { [TRACK]: [5, 15] } },
    });
    const trim = appliedEditRecord({
      id: "trim",
      operation: "trim_clip_edge",
      timeline_start: 30,
      timeline_end: 40,
      source_start: 50,
      source_end: 58,
      params: { edge: "out" },
    });

    const ticks = appliedEditTicks([rippleA, rippleB, trim], TRACK, clips);

    expect(ticks).toHaveLength(3);
    expect(
      ticks.map((t) => ({ recordId: t.recordId, kind: t.kind, sec: t.sec })),
    ).toEqual([
      { recordId: "ripple-a", kind: "seam", sec: 30 },
      { recordId: "ripple-b", kind: "seam", sec: 5 },
      { recordId: "trim", kind: "edge", sec: 38 },
    ]);
    for (const t of ticks) {
      expect(t.sec).toBeLessThanOrEqual(38);
      expect((t as { width?: number }).width).toBeUndefined();
    }
  });

  it("drops a legacy ripple_delete with no source clocks", () => {
    const clips = [
      clipRow({
        source_start: 0,
        source_end: 60,
        timeline_start: 0,
        timeline_end: 1160,
      }),
    ];
    const legacy = appliedEditRecord({
      id: "legacy",
      operation: "ripple_delete",
      timeline_start: 0,
      timeline_end: 1334.8,
      source_start: null,
      source_end: null,
      params: {},
    });
    expect(appliedEditTicks([legacy], TRACK, clips)).toEqual([]);
  });

  it("drops records on another track", () => {
    const clips = [clipRow()];
    const other = appliedEditRecord({ id: "other", track_ids: ["ari-voice"] });
    expect(appliedEditTicks([other], TRACK, clips)).toEqual([]);
  });

  it("maps split_clips_at through split_source_by_track to one edge tick", () => {
    const clips = [
      clipRow({
        id: "left",
        source_start: 0,
        source_end: 5,
        timeline_start: 0,
        timeline_end: 5,
      }),
      clipRow({
        id: "right",
        source_start: 5,
        source_end: 10,
        timeline_start: 5,
        timeline_end: 10,
      }),
    ];
    const split = appliedEditRecord({
      id: "split",
      operation: "split_clips_at",
      timeline_start: 5,
      timeline_end: 5,
      source_start: null,
      source_end: null,
      params: { split_source_by_track: { [TRACK]: 5 } },
    });
    const ticks = appliedEditTicks([split], TRACK, clips);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ kind: "edge", sec: 5 });
  });

  it("gives nothing for approve_split without split_source_by_track, even with a decision source clock", () => {
    const clips = [
      clipRow({
        id: "left",
        source_start: 0,
        source_end: 5,
        timeline_start: 0,
        timeline_end: 5,
      }),
      clipRow({
        id: "right",
        source_start: 5,
        source_end: 10,
        timeline_start: 5,
        timeline_end: 10,
      }),
    ];
    const approveSplit = appliedEditRecord({
      id: "approve-split",
      operation: "approve_split",
      source_start: 5,
      source_end: 5,
      params: {},
    });
    expect(appliedEditTicks([approveSplit], TRACK, clips)).toEqual([]);
  });

  it("gives two seam ticks for a punch_delete hole", () => {
    const clips = [
      clipRow({
        id: "before",
        source_start: 0,
        source_end: 5,
        timeline_start: 0,
        timeline_end: 5,
      }),
      clipRow({
        id: "after",
        source_start: 8,
        source_end: 10,
        timeline_start: 8,
        timeline_end: 10,
      }),
    ];
    const punch = appliedEditRecord({
      id: "punch",
      operation: "punch_delete",
      timeline_start: 5,
      timeline_end: 8,
      source_start: null,
      source_end: null,
      params: { per_track_source: { [TRACK]: [5, 8] } },
    });
    const ticks = appliedEditTicks([punch], TRACK, clips);
    expect(ticks.map((t) => t.sec)).toEqual([5, 8]);
    expect(ticks.every((t) => t.kind === "seam")).toBe(true);
  });

  it("gives one edge tick for a roll_clip_join", () => {
    const clips = [
      clipRow({
        id: "left",
        source_start: 0,
        source_end: 6,
        timeline_start: 0,
        timeline_end: 20,
      }),
      clipRow({
        id: "right",
        source_start: 6,
        source_end: 12,
        timeline_start: 20,
        timeline_end: 26,
      }),
    ];
    const roll = appliedEditRecord({
      id: "roll",
      operation: "roll_clip_join",
      source_start: 6,
      source_end: 6,
    });
    const ticks = appliedEditTicks([roll], TRACK, clips);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ kind: "edge", sec: 20 });
  });

  it("gives two edge ticks for a mute inside a clip", () => {
    const clips = [
      clipRow({
        id: "c",
        source_start: 0,
        source_end: 10,
        timeline_start: 20,
        timeline_end: 30,
      }),
    ];
    const mute = appliedEditRecord({
      id: "mute",
      operation: "approve_edits",
      source_start: 2,
      source_end: 3,
      params: { mute: true },
    });
    const ticks = appliedEditTicks([mute], TRACK, clips);
    expect(ticks.map((t) => t.sec)).toEqual([22, 23]);
    expect(ticks.every((t) => t.kind === "edge")).toBe(true);
  });

  it("gives a tick at the moved clip's timeline_start for move_clips", () => {
    const clips = [
      clipRow({
        id: "moved",
        source_start: 0,
        source_end: 5,
        timeline_start: 12,
        timeline_end: 17,
      }),
    ];
    const move = appliedEditRecord({
      id: "move",
      operation: "move_clips",
      params: { clips: [{ clip_id: "moved", track_id: TRACK }] },
    });
    const ticks = appliedEditTicks([move], TRACK, clips);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ kind: "edge", sec: 12 });
  });

  it("drops a removal whose anchor edge was later trimmed away", () => {
    const clips = [
      clipRow({
        id: "c",
        source_start: 20,
        source_end: 30,
        timeline_start: 0,
        timeline_end: 10,
      }),
    ];
    const ripple = appliedEditRecord({
      id: "ripple",
      operation: "ripple_delete",
      source_start: null,
      source_end: null,
      params: { per_track_source: { [TRACK]: [2, 3] } },
    });
    expect(appliedEditTicks([ripple], TRACK, clips)).toEqual([]);
  });
});

describe("appliedEditTitle", () => {
  it("labels a ripple delete with no reason", () => {
    expect(
      appliedEditTitle(
        appliedEditRecord({ operation: "ripple_delete", reason: null }),
      ),
    ).toBe("Ripple delete");
  });

  it("labels a decision-approved cut with its reason", () => {
    expect(
      appliedEditTitle(
        appliedEditRecord({ operation: "approve_edits", reason: "filler:um" }),
      ),
    ).toBe("Cut: filler:um");
  });

  it("labels a mute record regardless of operation", () => {
    expect(
      appliedEditTitle(
        appliedEditRecord({
          operation: "approve_edits",
          reason: null,
          params: { mute: true },
        }),
      ),
    ).toBe("Mute");
  });

  it("humanizes an unknown operation as a fallback", () => {
    expect(
      appliedEditTitle(appliedEditRecord({ operation: "remove", reason: "x" })),
    ).toBe("Remove: x");
  });
});

describe("appliedRecordOnTimeline", () => {
  it("is true when the record maps to a tick on any of its tracks", () => {
    const record = appliedEditRecord({
      operation: "ripple_delete",
      track_ids: [TRACK],
      source_start: null,
      source_end: null,
      params: { per_track_source: { [TRACK]: [2, 3] } },
    });
    const clipsByTrack = {
      [TRACK]: [
        clipRow({
          id: "c1",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
        }),
        clipRow({
          id: "c2",
          source_start: 3,
          source_end: 9,
          timeline_start: 2,
          timeline_end: 8,
        }),
      ],
    };
    expect(appliedRecordOnTimeline(record, clipsByTrack)).toBe(true);
  });

  it("is false when no track maps", () => {
    const record = appliedEditRecord({
      operation: "ripple_delete",
      track_ids: [TRACK],
      source_start: null,
      source_end: null,
      params: {},
    });
    expect(appliedRecordOnTimeline(record, { [TRACK]: [clipRow()] })).toBe(
      false,
    );
  });
});
