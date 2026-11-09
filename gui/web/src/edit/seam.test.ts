import { describe, expect, it } from "vitest";
import {
  appliedEditRecord,
  clipRow,
  editBoundary,
  minimalProject,
} from "../test/fixtures";
import type {
  AppliedEditRecord,
  ClipRow,
  EditBoundaryView,
  ProjectView,
} from "../types/project";
import {
  type CutSeam,
  keepPlan,
  seamById,
  seamsOnTrack,
  seamTitle,
  UNDO_IN_HISTORY,
} from "./seam";

const TRACK = "mira-voice";

function removal(
  id: string,
  sourceStart: number,
  sourceEnd: number,
  overrides: Partial<AppliedEditRecord> = {},
): AppliedEditRecord {
  return appliedEditRecord({
    id,
    operation: "ripple_delete",
    source_start: sourceStart,
    source_end: sourceEnd,
    timeline_start: sourceStart,
    timeline_end: sourceEnd,
    reason: "filler",
    restore: { state: "ready" },
    ...overrides,
  });
}

function project(
  clips: ClipRow[],
  records: AppliedEditRecord[] = [],
  boundaries?: EditBoundaryView[],
): ProjectView {
  const rows =
    boundaries ??
    clips.slice(1).map((right, i) => editBoundary(clips[i], right));
  return minimalProject({
    clips: { tracks: { [TRACK]: clips }, clip_count: clips.length },
    edit_boundaries: rows,
    applied_edits: { count: records.length, records },
  });
}

const A = clipRow({
  id: "a",
  source_start: 0,
  source_end: 4,
  timeline_start: 0,
  timeline_end: 4,
});
const B = clipRow({
  id: "b",
  source_start: 6.4,
  source_end: 10,
  timeline_start: 4,
  timeline_end: 7.6,
});
const SPLIT_L = clipRow({
  id: "s1",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
});
const SPLIT_R = clipRow({
  id: "s2",
  source_start: 5,
  source_end: 9,
  timeline_start: 5,
  timeline_end: 9,
});

function onlyCut(seams: readonly { kind: string }[]): CutSeam {
  const seam = seams[0];
  if (seam.kind !== "cut") throw new Error("expected a cut seam");
  return seam as CutSeam;
}

describe("seamsOnTrack", () => {
  it("reads a seam with no cutaway and no record as a split", () => {
    const seams = seamsOnTrack(project([SPLIT_L, SPLIT_R]), TRACK);
    expect(seams).toHaveLength(1);
    expect(seams[0].kind).toBe("split");
    expect(seams[0].id).toBe("eb:s1:s2");
    expect(seams[0].joinSec).toBe(5);
    expect(seams[0].abuts).toBe(true);
    expect(seamTitle(seams[0])).toBe("Split at 0:05.0");
  });

  it("reads a cutaway with one record as a cut that carries the record", () => {
    const record = removal("r1", 4, 6.4);
    const seam = onlyCut(seamsOnTrack(project([A, B], [record]), TRACK));
    expect(seam.records.map((r) => r.id)).toEqual(["r1"]);
    expect(seam.removedSec).toBeCloseTo(2.4, 6);
    expect(seamTitle(seam)).toBe("2.4 s cut · filler");
  });

  it("reads a cutaway whose record is gone as a cut with no records", () => {
    const seam = onlyCut(seamsOnTrack(project([A, B]), TRACK));
    expect(seam.records).toEqual([]);
  });

  it("assigns two records cut at one join to that seam", () => {
    const records = [removal("r1", 4, 5), removal("r2", 5, 6.4)];
    const seam = onlyCut(seamsOnTrack(project([A, B], records), TRACK));
    expect(seam.records.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("still matches a record after a roll moved the cutaway edges", () => {
    const rolledLeft = { ...A, source_end: 4.2, timeline_end: 4.2 };
    const rolledRight = { ...B, source_start: 6.6, timeline_start: 4.2 };
    const seam = onlyCut(
      seamsOnTrack(
        project([rolledLeft, rolledRight], [removal("r1", 4, 6.4)]),
        TRACK,
      ),
    );
    expect(seam.records.map((r) => r.id)).toEqual(["r1"]);
  });

  it("matches a record with no source anchors by the join second within 20 ms", () => {
    const record = removal("r1", 0, 0, {
      source_start: null,
      source_end: null,
      timeline_start: 4.01,
      timeline_end: 4.01,
    });
    const seam = onlyCut(seamsOnTrack(project([A, B], [record]), TRACK));
    expect(seam.records.map((r) => r.id)).toEqual(["r1"]);
    const far = { ...record, timeline_start: 4.5, timeline_end: 4.5 };
    expect(
      onlyCut(seamsOnTrack(project([A, B], [far]), TRACK)).records,
    ).toEqual([]);
  });

  it("gives a record whose source repeats to the nearest seam only", () => {
    const c = clipRow({
      id: "c",
      source_start: 0,
      source_end: 4,
      timeline_start: 7.6,
      timeline_end: 11.6,
    });
    const d = clipRow({
      id: "d",
      source_start: 6.4,
      source_end: 10,
      timeline_start: 11.6,
      timeline_end: 15.2,
    });
    const record = removal("r1", 4, 6.4, { timeline_start: 11.6 });
    const seams = seamsOnTrack(
      project(
        [A, B, c, d],
        [record],
        [
          editBoundary(A, B),
          editBoundary(B, c, { has_cutaway: false }),
          editBoundary(c, d),
        ],
      ),
      TRACK,
    );
    const cuts = seams.filter((s) => s.kind === "cut") as CutSeam[];
    expect(cuts.map((s) => [s.id, s.records.length])).toEqual([
      ["eb:a:b", 0],
      ["eb:c:d", 1],
    ]);
  });

  it("counts the tracks of a record cut on two tracks", () => {
    const record = removal("r1", 4, 6.4, { track_ids: [TRACK, "tomas-voice"] });
    const seam = onlyCut(seamsOnTrack(project([A, B], [record]), TRACK));
    const plan = keepPlan(seam);
    expect(plan.kind === "restore" && plan.trackCount).toBe(2);
  });

  it("marks a gapped pair as not abutting", () => {
    const gapped = { ...B, timeline_start: 6, timeline_end: 9.6 };
    expect(seamsOnTrack(project([A, gapped]), TRACK)[0].abuts).toBe(false);
  });

  it("takes the join second from the clip rows when the boundary row is stale", () => {
    const stale = editBoundary(SPLIT_L, SPLIT_R, { timeline_join_sec: 1 });
    const rolled = { ...SPLIT_L, timeline_end: 5.2 };
    const seams = seamsOnTrack(project([rolled, SPLIT_R], [], [stale]), TRACK);
    expect(seams[0].joinSec).toBe(5.2);
  });

  it("returns the same array while the inputs keep their identity", () => {
    const view = project([A, B]);
    expect(seamsOnTrack(view, TRACK)).toBe(seamsOnTrack(view, TRACK));
  });
});

describe("seamById", () => {
  it("finds a seam and drops one whose pair is gone", () => {
    const view = project([SPLIT_L, SPLIT_R]);
    expect(seamById(view, "eb:s1:s2")?.kind).toBe("split");
    const merged = project([SPLIT_L], [], [editBoundary(SPLIT_L, SPLIT_R)]);
    expect(seamById(merged, "eb:s1:s2")).toBeNull();
    expect(seamById(view, "eb:nope:nope")).toBeNull();
  });
});

describe("keepPlan", () => {
  function cut(records: AppliedEditRecord[]): CutSeam {
    return onlyCut(seamsOnTrack(project([A, B], records), TRACK));
  }

  it("restores every ready record in one batch", () => {
    expect(keepPlan(cut([removal("r1", 4, 5), removal("r2", 5, 6.4)]))).toEqual(
      {
        kind: "restore",
        ids: ["r1", "r2"],
        trackCount: 1,
      },
    );
  });

  it("restores a record blocked only by another record in the batch", () => {
    const blocked = removal("r1", 4, 5, {
      restore: {
        state: "blocked",
        code: "overlap",
        message: "Later edit",
        blocked_by: ["r2"],
      },
    });
    expect(keepPlan(cut([blocked, removal("r2", 5, 6.4)]))).toEqual({
      kind: "restore",
      ids: ["r1", "r2"],
      trackCount: 1,
    });
  });

  it("disables with the record message when an outside edit blocks it", () => {
    const blocked = removal("r1", 4, 6.4, {
      restore: {
        state: "blocked",
        code: "overlap",
        message: "Undo the later trim first",
        blocked_by: ["rX"],
      },
    });
    expect(keepPlan(cut([blocked]))).toEqual({
      kind: "disabled",
      reason: "Undo the later trim first",
      openHistory: false,
    });
  });

  it("disables with the record message when a blocked record names no blocker", () => {
    const orphan = removal("r1", 4, 6.4, {
      restore: {
        state: "blocked",
        code: "span_not_present",
        message: "The audio is no longer there",
        blocked_by: [],
      },
    });
    expect(keepPlan(cut([orphan]))).toEqual({
      kind: "disabled",
      reason: "The audio is no longer there",
      openHistory: false,
    });
  });

  it("sends a history-only record or a record-less cut to History", () => {
    const historyOnly = removal("r1", 4, 6.4, {
      restore: { state: "history_only" },
    });
    const expected = {
      kind: "disabled",
      reason: UNDO_IN_HISTORY,
      openHistory: true,
    };
    expect(keepPlan(cut([historyOnly]))).toEqual(expected);
    expect(keepPlan(cut([removal("r2", 4, 5), historyOnly]))).toEqual(expected);
    expect(keepPlan(cut([]))).toEqual(expected);
  });
});
