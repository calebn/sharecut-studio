import { describe, expect, it } from "vitest";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import type { ExactRangeTarget } from "../types/project";
import { appliedEditTicks, appliedEditTitle } from "./appliedEditTicks";

const TRACK = "mira-voice";

describe("appliedEditTicks", () => {
  it("projects manual room fill through the inserted clips, without matching reused source", () => {
    const record = appliedEditRecord({
      operation: "fill_with_room_tone",
      source_start: null,
      source_end: null,
      timeline_start: null,
      timeline_end: null,
      params: {
        clips: [
          { clip_id: "fill-a", track_id: TRACK },
          { clip_id: "fill-b", track_id: TRACK },
        ],
        pad_samples: [
          {
            track_id: TRACK,
            source_id: null,
            source_start: 5,
            source_end: 5.25,
          },
          {
            track_id: TRACK,
            source_id: null,
            source_start: 5,
            source_end: 5.25,
          },
        ],
      },
    });
    const clips = [
      clipRow({
        id: "original",
        source_start: 5,
        source_end: 5.25,
        timeline_start: 0,
        timeline_end: 0.25,
      }),
      clipRow({
        id: "fill-a",
        source_start: 5,
        source_end: 5.25,
        timeline_start: 2,
        timeline_end: 2.25,
      }),
      clipRow({
        id: "fill-b",
        source_start: 5,
        source_end: 5.25,
        timeline_start: 2.25,
        timeline_end: 2.5,
      }),
    ];
    expect(
      appliedEditTicks([record], TRACK, clips).map((tick) => tick.sec),
    ).toEqual([2, 2.25]);
    expect(
      appliedEditTicks([record], TRACK, [clips[0], clips[2]]).map(
        (tick) => tick.sec,
      ),
    ).toEqual([2.25]);
  });
  it.each(["cut", "mute"])(
    "projects exact %s islands only at the selected repeated placement",
    (action) => {
      const original = clipRow({
        id: "selected-copy",
        track_id: TRACK,
        source_id: "recording",
        source_start: 0,
        source_end: 5,
        timeline_start: 10,
        timeline_end: 15,
      });
      const target: ExactRangeTarget = {
        kind: "exact_range",
        intervals: [
          { start: 11, end: 12 },
          { start: 13, end: 14 },
        ],
        track_ids: [TRACK],
        clips: [{ ...original, mute_regions: [] }],
        media_seals: { [TRACK]: "seal" },
      };
      const record = appliedEditRecord({
        operation: "edit_selected_range",
        source_start: null,
        source_end: null,
        timeline_start: 11,
        timeline_end: 14,
        params: { action, exact_range: target },
        reason: null,
      });
      const firstCopy = {
        ...original,
        id: "first-copy",
        timeline_start: 0,
        timeline_end: 5,
      };
      const kept =
        action === "mute"
          ? [original]
          : [
              { ...original, id: "left", source_end: 1, timeline_end: 11 },
              {
                ...original,
                id: "middle",
                source_start: 2,
                source_end: 3,
                timeline_start: 12,
                timeline_end: 13,
              },
              {
                ...original,
                id: "right",
                source_start: 4,
                timeline_start: 14,
                timeline_end: 15,
              },
            ];
      const ticks = appliedEditTicks([record], TRACK, [firstCopy, ...kept]);
      expect(ticks.map((t) => t.sec)).toEqual(
        action === "mute" ? [11, 12, 13, 14] : [],
      );
      expect(appliedEditTitle(record)).toBe(action === "mute" ? "Mute" : "Cut");
      expect(appliedEditTicks([record], "peer", [firstCopy])).toEqual([]);
    },
  );
  it("draws no tick for stacked ripples, only for the trim", () => {
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

    expect(ticks).toHaveLength(1);
    expect(ticks.map((t) => ({ recordId: t.recordId, sec: t.sec }))).toEqual([
      { recordId: "trim", sec: 38 },
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
    expect(ticks[0]).toMatchObject({ sec: 5 });
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
    expect(ticks[0]).toMatchObject({ sec: 20 });
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
    expect(ticks.every((t) => t.mute)).toBe(true);
  });

  it("flags only a mute record's ticks as mute", () => {
    const clips = [
      clipRow({
        id: "c",
        source_start: 0,
        source_end: 10,
        timeline_start: 20,
        timeline_end: 30,
      }),
    ];
    const roll = appliedEditRecord({
      id: "roll",
      operation: "roll_clip_join",
      params: { clips: [{ clip_id: "c", track_id: TRACK }] },
    });
    expect(appliedEditTicks([roll], TRACK, clips).some((t) => t.mute)).toBe(
      false,
    );
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
    expect(ticks[0]).toMatchObject({ sec: 12 });
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

  it("breaks a single-edge tie by the record's stored timeline clock", () => {
    const clips = [
      clipRow({
        id: "first",
        source_start: 0,
        source_end: 6,
        timeline_start: 0,
        timeline_end: 6,
      }),
      clipRow({
        id: "copy",
        source_start: 0,
        source_end: 6,
        timeline_start: 20,
        timeline_end: 26,
      }),
    ];
    const trim = appliedEditRecord({
      id: "trim",
      operation: "trim_clip_edge",
      timeline_start: 20,
      timeline_end: 26,
      source_start: 0,
      source_end: 6,
      params: { edge: "out" },
    });
    const ticks = appliedEditTicks([trim], TRACK, clips);
    expect(ticks.map((t) => t.sec)).toEqual([26]);
  });

  it("draws nothing for delete_clips, which records no source clocks", () => {
    const clips = [clipRow({ source_start: 2, source_end: 3 })];
    const del = appliedEditRecord({
      id: "del",
      operation: "delete_clips",
      params: { clip_ids: ["gone"], ripple: false },
    });
    expect(appliedEditTicks([del], TRACK, clips)).toEqual([]);
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
