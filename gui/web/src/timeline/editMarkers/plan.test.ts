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

  it("starts with the drawn 99+ when a chip holds more than 99 joins (WCAG 2.5.3)", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      mark(i, { kind: i % 2 ? "join-cut" : "join-crossfade" }, `m${i}`),
    );
    expect(chipLabel({ ...chip(300), marks: many })).toBe(
      "99+ edits: 60 cuts, 60 crossfades. Zoom in",
    );
    expect(chipLabel({ ...chip(300), marks: many.slice(0, 99) })).toMatch(
      /^99 edits:/,
    );
  });
});

describe("planLaneMarks tier, label and room", () => {
  const crossfade = (sec: number, ms: number, id = `x${sec}`) =>
    mark(
      sec,
      {
        kind: "join-crossfade",
        right: clipRow({
          id,
          timeline_start: sec,
          join_in_mode: "crossfade",
          join_crossfade_ms: ms,
        }),
      },
      id,
    );

  it.each([
    [66, "narrow", 7.92],
    [200, "middle", 24],
    [1000, "wide", 120],
  ] as const)(
    "tiers a 120 ms crossfade at %f px/s as %s from its drawn width",
    (zoom, tier, drawnPx) => {
      const [symbol] = planAt([crossfade(10, 120)], zoom).symbols;
      expect(symbol.tier).toBe(tier);
      expect(symbol.drawnPx).toBeCloseTo(drawnPx, 9);
    },
  );

  it("tiers a point join narrow with no drawn overlap", () => {
    const [symbol] = planAt([mark(10)], 1000).symbols;
    expect(symbol.tier).toBe("narrow");
    expect(symbol.drawnPx).toBe(0);
  });

  it("reads the open draft's overlap instead of the saved one", () => {
    const saved = crossfade(10, 20);
    const draft = { ...saved.right, join_crossfade_ms: 200 };
    expect(planAt([saved], 200).symbols[0].tier).toBe("narrow");
    const drafted = planLaneMarks([saved], 200, SESSION_SEC, draft);
    expect(drafted.symbols[0].tier).toBe("wide");
    expect(drafted.symbols[0].label).toBe("Crossfade 200 ms");
  });

  it("ignores a draft for another join", () => {
    const other = clipRow({ id: "other", join_crossfade_ms: 400 });
    const plan = planLaneMarks([crossfade(10, 20)], 200, SESSION_SEC, other);
    expect(plan.symbols[0].tier).toBe("narrow");
  });

  it("labels each type from the registry with its length", () => {
    const fade = mark(
      30,
      {
        kind: "join-fade",
        left: clipRow({ fade_out_ms: 80 }),
        right: clipRow({ fade_in_ms: 40 }),
      },
      "f",
    );
    const labels = planAt([mark(10), fade, crossfade(50, 120)], 3).symbols.map(
      (s) => s.label,
    );
    expect(labels).toEqual(["Cut", "Fade 80 ms", "Crossfade 120 ms"]);
  });

  it("allows a label on a point join and on a wide crossfade only", () => {
    const allowed = (zoom: number, m: JoinMark) =>
      planAt([m], zoom).symbols[0].labelAllowed;
    expect(allowed(1, mark(10))).toBe(true);
    expect(allowed(66, crossfade(10, 120))).toBe(false);
    expect(allowed(200, crossfade(10, 120))).toBe(false);
    expect(allowed(1000, crossfade(10, 120))).toBe(true);
  });

  it("measures the room to the next mark, less the glyph and gap, and to the session end for the last", () => {
    const plan = planAt([mark(0), mark(100), mark(599)], 1);
    expect(plan.symbols.map((s) => s.roomPx)).toEqual([
      100 - 6 - 6 - 4,
      499 - 6 - 6 - 4,
      1 - 6 - 4,
    ]);
  });

  it("reserves a chip's half width when the next group is a chip", () => {
    const plan = planAt([mark(0), mark(100), mark(110)], 1);
    expect(plan.symbols[0].roomPx).toBe(105 - 12 - 6 - 4);
  });
});
