import { describe, expect, it } from "vitest";
import { joinVisual } from "../../edit/joinRender";
import { clipRow } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { clampZoomPxPerSec } from "../../utils/zoom";
import {
  chipLabel,
  clusterZoom,
  collectJoinMarks,
  type JoinMark,
  type LanePlan,
  type PlacedChip,
  planLaneMarks,
} from "./plan";

const mark = (
  sec: number,
  over: Partial<JoinMark> = {},
  id = `m${sec}`,
): JoinMark => ({
  id,
  clipId: id,
  kind: "join-cut",
  sec,
  crossfadeMs: undefined,
  ...over,
});

const xs = (plan: LanePlan) =>
  [...plan.symbols.map((s) => s.xPx), ...plan.chips.map((c) => c.xPx)].sort(
    (a, b) => a - b,
  );

describe("planLaneMarks", () => {
  it("folds marks closer than 24 px into one chip and keeps the loner a symbol", () => {
    const plan = planLaneMarks(
      [0, 10, 20, 60].map((s) => mark(s)),
      1,
    );
    expect(plan.chips).toHaveLength(1);
    expect(plan.chips[0].marks.map((m) => m.sec)).toEqual([0, 10, 20]);
    expect(plan.chips[0].xPx).toBe(10);
    expect(plan.chips[0].startSec).toBe(0);
    expect(plan.chips[0].endSec).toBe(20);
    expect(plan.symbols.map((s) => s.mark.sec)).toEqual([60]);
  });

  it("merges a 23.99 px gap and keeps a 24 px gap apart", () => {
    expect(planLaneMarks([mark(0), mark(23.99)], 1).chips).toHaveLength(1);
    const apart = planLaneMarks([mark(0), mark(24)], 1);
    expect(apart.chips).toHaveLength(0);
    expect(apart.symbols).toHaveLength(2);
  });

  it("links a chain end to end: each step under 24 px joins the group", () => {
    const plan = planLaneMarks(
      [0, 20, 40, 60].map((s) => mark(s)),
      1,
    );
    expect(plan.chips.map((c) => c.marks.length)).toEqual([4]);
    expect(plan.chips[0].xPx).toBe(30);
  });

  it("gives the same plan for shuffled input", () => {
    const secs = [60, 0, 20, 10, 200, 250, 5];
    const forward = planLaneMarks(
      secs.map((s) => mark(s)),
      1,
    );
    const reversed = planLaneMarks(
      [...secs].reverse().map((s) => mark(s)),
      1,
    );
    expect(reversed).toEqual(forward);
  });

  it("keeps adjacent placed marks at least 24 px apart across zooms", () => {
    const secs = Array.from({ length: 30 }, (_, i) => i * 90 + ((i * 37) % 55));
    const marks = secs.map((s) => mark(s));
    for (const zoom of [0.05, 0.1, 0.25, 0.5, 1, 2, 8]) {
      const plan = planLaneMarks(marks, zoom);
      const placed = xs(plan);
      for (let i = 1; i < placed.length; i += 1) {
        expect(placed[i] - placed[i - 1]).toBeGreaterThanOrEqual(24);
      }
      const total =
        plan.symbols.length +
        plan.chips.reduce((n, c) => n + c.marks.length, 0);
      expect(total).toBe(30);
    }
  });

  it("draws a 120 ms crossfade at 50 px/s as a 6 px box and drops the stretched X", () => {
    const plan = planLaneMarks(
      [mark(5, { kind: "join-crossfade", crossfadeMs: 120 })],
      50,
    );
    expect(plan.symbols[0].box).toEqual({ leftPx: 247, widthPx: 6 });
    expect(plan.symbols[0].narrow).toBe(true);
  });

  it("keeps the X from 8 px of overlap and drops it below", () => {
    const narrowAt = (ms: number) =>
      planLaneMarks([mark(5, { kind: "join-crossfade", crossfadeMs: ms })], 50)
        .symbols[0].narrow;
    expect(narrowAt(159)).toBe(true);
    expect(narrowAt(160)).toBe(false);
  });

  it("never marks a cut as narrow", () => {
    expect(planLaneMarks([mark(0)], 1).symbols[0].narrow).toBe(false);
  });

  it("draws no box for a crossfade that is blocked or has no overlap", () => {
    const blocked = mark(5, {
      kind: "join-crossfade",
      crossfadeMs: 120,
      blocked: "no_fade_in",
    });
    const none = mark(9, { kind: "join-crossfade", crossfadeMs: 0 });
    const plan = planLaneMarks([blocked, none], 50);
    expect(plan.symbols.map((s) => s.box)).toEqual([null, null]);
  });

  it("returns nothing for no marks", () => {
    expect(planLaneMarks([], 50)).toEqual({ symbols: [], chips: [] });
  });
});

describe("crossfade box exactness", () => {
  const zooms = Array.from({ length: 24 }, (_, i) => 0.05 * 2 ** i).filter(
    (z) => z <= 48000,
  );

  it("equals joinVisual at every zoom, for every overlap, narrow or not", () => {
    const narrows = new Set<boolean>();
    for (const ms of [1, 20, 120, 400, 2000]) {
      const left = clipRow({
        id: "a",
        source_end: 5,
        timeline_end: 5,
        source_duration_sec: 100,
      });
      const right = clipRow({
        id: "b",
        source_start: 5,
        source_end: 10,
        timeline_start: 5,
        timeline_end: 10,
        join_in_mode: "crossfade",
        join_left_clip_id: "a",
        join_crossfade_ms: ms,
        source_duration_sec: 100,
      });
      for (const zoom of zooms) {
        const marks = collectJoinMarks([left, right], null, () => false);
        const [symbol] = planLaneMarks(marks, zoom).symbols;
        const visual = joinVisual(right, zoom);
        expect(visual.kind).toBe("blend");
        if (visual.kind !== "blend") continue;
        expect(symbol.box).toEqual({
          leftPx: visual.leftPx,
          widthPx: visual.widthPx,
        });
        narrows.add(symbol.narrow);
      }
    }
    expect([...narrows].sort()).toEqual([false, true]);
  });
});

describe("collectJoinMarks", () => {
  const a = clipRow({ id: "a", timeline_end: 5, source_end: 5 });
  const b = (over: Partial<ClipRow> = {}) =>
    clipRow({
      id: "b",
      source_start: 5,
      source_end: 10,
      timeline_start: 5,
      timeline_end: 10,
      join_left_clip_id: "a",
      ...over,
    });
  const still = () => false;

  it("marks each join once, typed by its mode, an unknown mode reading fade", () => {
    expect(
      collectJoinMarks([a, b({ join_in_mode: "cut" })], null, still).map(
        (m) => [m.id, m.kind, m.sec],
      ),
    ).toEqual([["join-b", "join-cut", 5]]);
    const weird = b({ join_in_mode: "weird" as ClipRow["join_in_mode"] });
    expect(collectJoinMarks([a, weird], null, still)[0].kind).toBe("join-fade");
  });

  it("skips a join with a moving neighbour, a gap, or another left clip", () => {
    expect(collectJoinMarks([a, b()], null, (id) => id === "a")).toEqual([]);
    expect(collectJoinMarks([a, b()], null, (id) => id === "b")).toEqual([]);
    expect(
      collectJoinMarks(
        [a, b({ timeline_start: 6, timeline_end: 11 })],
        null,
        still,
      ),
    ).toEqual([]);
    expect(
      collectJoinMarks([a, b({ join_left_clip_id: "z" })], null, still),
    ).toEqual([]);
    expect(collectJoinMarks([a], null, still)).toEqual([]);
  });

  it("follows a live roll of the join", () => {
    const rolled = collectJoinMarks(
      [a, b()],
      { leftClipId: "a", rightClipId: "b", deltaSec: 0.5 },
      still,
    );
    expect(rolled.map((m) => m.sec)).toEqual([5.5]);
  });

  it("carries the blocked reason and the crossfade length", () => {
    const [m] = collectJoinMarks(
      [
        a,
        b({
          join_in_mode: "crossfade",
          join_crossfade_ms: 40,
          join_crossfade_blocked: "no_fade_in",
        }),
      ],
      null,
      still,
    );
    expect(m.blocked).toBe("no_fade_in");
    expect(m.crossfadeMs).toBe(40);
  });
});

describe("clusterZoom", () => {
  const chip = (secs: number[]): PlacedChip => ({
    marks: secs.map((s) => mark(s)),
    xPx: 0,
    startSec: secs[0],
    endSec: secs[secs.length - 1],
  });

  it("zooms until the closest members sit 30 px apart", () => {
    expect(clusterZoom(chip([1, 1.1, 1.2, 1.5]), 600)).toBeCloseTo(300, 9);
    expect(clusterZoom(chip([1, 1.1, 1.3]), 600)).toBeCloseTo(300, 9);
  });

  it("clamps at the session's maximum zoom", () => {
    expect(clusterZoom(chip([1, 1.0000001]), 600)).toBe(
      clampZoomPxPerSec(Number.POSITIVE_INFINITY, 600),
    );
  });
});

describe("chipLabel", () => {
  it("counts joins by type in cut, fade, crossfade order", () => {
    const marks = [
      mark(0, { kind: "join-crossfade" }, "x"),
      mark(1, { kind: "join-cut" }, "y"),
      mark(2, { kind: "join-cut" }, "z"),
    ];
    expect(chipLabel({ marks, xPx: 0, startSec: 0, endSec: 2 })).toBe(
      "3 edits: 2 cuts, 1 crossfade. Zoom in",
    );
  });
});
