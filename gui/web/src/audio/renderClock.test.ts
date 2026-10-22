import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { buildRenderClock, placeLikeRender } from "./renderClock";

type FixtureRow = Omit<ClipRow, "source_id" | "recording_key"> & {
  placed_start: number;
};
interface FixtureCase {
  name: string;
  clips: FixtureRow[];
}

const CASES: FixtureCase[] = JSON.parse(
  readFileSync(
    `${process.cwd()}/../../tests/fixtures/render_clock/cases.json`,
    "utf8",
  ),
).cases;

function rows(c: FixtureCase): ClipRow[] {
  return c.clips.map(({ placed_start: _placed, ...row }) => ({
    source_id: null,
    recording_key: null,
    ...row,
  }));
}

describe("render clock pinned to timeline_render._place_clips (#1888)", () => {
  it.each(CASES)("places every clip where the render does: $name", (c) => {
    const { placed } = placeLikeRender(rows(c));
    placed.forEach((clip, index) => {
      expect(clip.timeline_start).toBeCloseTo(c.clips[index].placed_start, 9);
    });
  });

  it.each(CASES)(
    "converts authored and render-clock seconds both ways inside each clip: $name",
    (c) => {
      const clock = buildRenderClock(rows(c));
      for (const row of c.clips) {
        const inside = (row.timeline_start + row.timeline_end) / 2;
        const rendered = clock.renderedAt(row.track_id, inside, row.id);
        expect(rendered).toBeCloseTo(
          row.placed_start + (inside - row.timeline_start),
          9,
        );
        expect(clock.authoredAt(row.track_id, rendered, row.id)).toBeCloseTo(
          inside,
          9,
        );
        expect(clock.offsetOf(row.id)).toBeCloseTo(
          row.placed_start - row.timeline_start,
          9,
        );
      }
    },
  );

  it("is the identity for a project with no blending crossfade", () => {
    const clock = buildRenderClock(rows(CASES[0]));
    expect(clock.identity).toBe(true);
    expect(clock.renderedAt("host", 7.5)).toBe(7.5);
    expect(clock.authoredAt("host", 7.5)).toBe(7.5);
  });

  it("keeps the identity through a blending crossfade, which borrows instead of shifting", () => {
    const c = CASES.find((x) => x.name === "one_blending_join_moves_nothing");
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    expect(clock.identity).toBe(true);
    expect(clock.renderedAt("host", 10)).toBe(10);
  });

  it("never borrows more than the recordings hold, whatever a stale row says", () => {
    const c = CASES.find((x) => x.name === "one_blending_join_moves_nothing");
    if (!c) throw new Error("missing case");
    const base = rows(c);
    const right = base.find((r) => r.join_borrow_sec);
    const left = base.find((r) => r.id === right?.join_left_clip_id);
    if (!right || !left) throw new Error("missing join");
    const stale = base.map((r) =>
      r === right
        ? { ...r, join_borrow_sec: 5, source_start: 0.002 }
        : r === left
          ? { ...r, source_duration_sec: left.source_end + 0.001 }
          : r,
    );
    const placed = placeLikeRender(stale);
    expect(placed.borrowIn.get(right.id) ?? 0).toBeLessThanOrEqual(0.002);
    expect(placed.borrowOut.get(left.id) ?? 0).toBeLessThanOrEqual(0.002);
  });

  it.each(["left", "right"] as const)(
    "borrows nothing when the %s recording's length is unmeasured, as the server does",
    (side) => {
      const c = CASES.find((x) => x.name === "one_blending_join_moves_nothing");
      if (!c) throw new Error("missing case");
      const base = rows(c);
      const right = base.find((r) => r.join_borrow_sec);
      const left = base.find((r) => r.id === right?.join_left_clip_id);
      if (!right || !left) throw new Error("missing join");
      const target = side === "left" ? left : right;
      const unmeasured = base.map((r) =>
        r === target ? { ...r, source_duration_sec: null } : r,
      );
      const placed = placeLikeRender(unmeasured);
      expect(placed.borrowOut.get(left.id) ?? 0).toBe(0);
      expect(placed.borrowIn.get(right.id) ?? 0).toBe(0);
      expect(placed.overlapIn.get(right.id) ?? 0).toBe(0);
      expect(placed.overlapOut.get(left.id) ?? 0).toBe(0);
    },
  );

  it("shifts only the lane that closes a gap, and carries the shift on", () => {
    const c = CASES.find(
      (x) =>
        x.name === "a_gap_inside_the_tolerance_closes_up_and_shifts_the_rest",
    );
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    expect(clock.identity).toBe(false);
    expect(clock.renderedAt("host", 3.9)).toBeCloseTo(3.9, 9);
    expect(clock.renderedAt("host", 6)).toBeCloseTo(5.97, 9);
    expect(clock.renderedAt("host", 9)).toBeCloseTo(8.94, 9);
    expect(clock.renderedAt("host", 30)).toBeCloseTo(29.94, 9);
    expect(clock.authoredAt("host", 5.97)).toBeCloseTo(6, 9);
    expect(clock.authoredAt("host", 29.94)).toBeCloseTo(30, 9);
  });

  it("stays the identity through float noise in abutting cut clips", () => {
    const starts = [0, 0.123, 1.457, 2.891, 3.333, 7.771];
    const clips = starts.slice(0, -1).map((start, index) => ({
      ...rows(CASES[0])[0],
      id: `n${index}`,
      timeline_start: start,
      timeline_end: starts[index + 1],
      source_end: starts[index + 1] - start,
    }));
    const clock = buildRenderClock(clips);
    expect(clock.identity).toBe(true);
    expect(clock.renderedAt("host", 3)).toBe(3);
  });
});
