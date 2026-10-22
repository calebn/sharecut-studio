import { describe, expect, it } from "vitest";
import { clipRow } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { effectiveMaxZoomPxPerSec } from "../../utils/timelineZoom.generated";
import {
  chipLabel,
  collectJoinMarks,
  type JoinMark,
  type LanePlan,
  type PlacedChip,
  planLaneMarks,
} from "./plan";

const SESSION_SEC = 600;
const row = clipRow({ id: "row" });

const mark = (
  sec: number,
  over: Partial<JoinMark> = {},
  id = `m${sec}`,
): JoinMark => ({
  id,
  clipId: id,
  kind: "join-cut",
  sec,
  left: row,
  right: row,
  ...over,
});

const planAt = (marks: readonly JoinMark[], zoom: number) =>
  planLaneMarks(marks, zoom, SESSION_SEC);

const xs = (plan: LanePlan) =>
  [...plan.symbols.map((s) => s.xPx), ...plan.chips.map((c) => c.xPx)].sort(
    (a, b) => a - b,
  );

describe("planLaneMarks", () => {
  it("folds marks closer than 24 px into one chip and keeps the loner a symbol", () => {
    const plan = planAt(
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
    expect(planAt([mark(0), mark(23.99)], 1).chips).toHaveLength(1);
    const apart = planAt([mark(0), mark(24)], 1);
    expect(apart.chips).toHaveLength(0);
    expect(apart.symbols).toHaveLength(2);
  });

  it("links a chain end to end: each step under 24 px joins the group", () => {
    const plan = planAt(
      [0, 20, 40, 60].map((s) => mark(s)),
      1,
    );
    expect(plan.chips.map((c) => c.marks.length)).toEqual([4]);
    expect(plan.chips[0].xPx).toBe(30);
  });

  it("gives the same plan for shuffled input", () => {
    const secs = [60, 0, 20, 10, 200, 250, 5];
    const forward = planAt(
      secs.map((s) => mark(s)),
      1,
    );
    const reversed = planAt(
      [...secs].reverse().map((s) => mark(s)),
      1,
    );
    expect(reversed).toEqual(forward);
  });

  it("keeps adjacent placed marks at least 24 px apart across zooms", () => {
    const secs = Array.from({ length: 30 }, (_, i) => i * 90 + ((i * 37) % 55));
    const marks = secs.map((s) => mark(s));
    for (const zoom of [0.05, 0.1, 0.25, 0.5, 1, 2, 8]) {
      const plan = planAt(marks, zoom);
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

  it("returns nothing for no marks", () => {
    expect(planAt([], 50)).toEqual({ symbols: [], chips: [] });
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

  it("carries the rows either side of the seam, as a live roll moves them", () => {
    const [still] = collectJoinMarks([a, b()], null, () => false);
    expect([still.left.id, still.right.id]).toEqual(["a", "b"]);
    expect(still.right.timeline_start).toBe(5);
    const [rolled] = collectJoinMarks(
      [a, b()],
      { leftClipId: "a", rightClipId: "b", deltaSec: 0.5 },
      () => false,
    );
    expect(rolled.right.timeline_start).toBe(5.5);
    expect(rolled.left.timeline_end).toBe(5.5);
  });
});

describe("a chip's zoom", () => {
  const chipAt = (secs: number[], zoom: number, sessionSec = SESSION_SEC) =>
    planLaneMarks(
      secs.map((s) => mark(s)),
      zoom,
      sessionSec,
    ).chips[0];

  it("zooms until the closest members sit 30 px apart", () => {
    expect(chipAt([1, 1.1, 1.2, 1.5], 10)?.zoomTo).toBeCloseTo(300, 9);
    expect(chipAt([1, 1.1, 1.3], 10)?.zoomTo).toBeCloseTo(300, 9);
  });

  it("zooms to the session's maximum for members that are one instant", () => {
    expect(chipAt([1, 1], 10)?.zoomTo).toBe(
      effectiveMaxZoomPxPerSec(SESSION_SEC),
    );
  });

  it("zooms to the maximum, short of the 30 px spacing, for members closer than it allows", () => {
    const max = effectiveMaxZoomPxPerSec(SESSION_SEC);
    expect(chipAt([1, 1 + 10 / max], 1)?.zoomTo).toBe(max);
  });

  it("cannot split a chip already at the maximum zoom", () => {
    const max = effectiveMaxZoomPxPerSec(SESSION_SEC);
    expect(chipAt([1, 1 + 10 / max], max)?.zoomTo).toBeNull();
    expect(chipAt([1, 1], max)?.zoomTo).toBeNull();
  });
});

describe("chipLabel", () => {
  const marks = [
    mark(0, { kind: "join-crossfade" }, "x"),
    mark(1, { kind: "join-cut" }, "y"),
    mark(2, { kind: "join-cut" }, "z"),
  ];
  const chip = (zoomTo: number | null): PlacedChip => ({
    marks,
    xPx: 0,
    startSec: 0,
    endSec: 2,
    zoomTo,
  });

  it("counts joins by type in cut, fade, crossfade order and offers the zoom", () => {
    expect(chipLabel(chip(300))).toBe("3 edits: 2 cuts, 1 crossfade. Zoom in");
  });

  it("offers no zoom to a chip that cannot split", () => {
    expect(chipLabel(chip(null))).toBe("3 edits: 2 cuts, 1 crossfade");
  });
});
