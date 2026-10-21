import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { buildRenderClock, placeLikeRender } from "./renderClock";

type FixtureRow = Omit<
  ClipRow,
  "source_id" | "source_duration_sec" | "recording_key"
> & { placed_start: number };
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
    ...row,
    source_id: null,
    source_duration_sec: null,
    recording_key: null,
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

  it("is not the identity once a join blends, and only for the lane that has one", () => {
    const c = CASES.find((x) => x.name === "lanes_shift_independently");
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    expect(clock.identity).toBe(false);
    expect(clock.renderedAt("host", 10)).toBeCloseTo(9.8, 9);
    expect(clock.renderedAt("guest", 10)).toBeCloseTo(10, 9);
  });

  it("carries the shift across a gap and back, and leaves time before the first clip alone", () => {
    const c = CASES.find(
      (x) => x.name === "overlaps_add_up_across_a_chain_and_a_gap",
    );
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    // Two blending joins pull the lane 0.3 + 0.4 earlier; a gap keeps the shift.
    expect(clock.renderedAt("host", 12)).toBeCloseTo(11.3, 9);
    expect(clock.authoredAt("host", 11.3)).toBeCloseTo(12, 9);
    expect(clock.renderedAt("host", 0)).toBe(0);
  });

  it("names the clip in a join's overlap, where two clips share one render second", () => {
    const c = CASES.find(
      (x) => x.name === "one_blending_join_pulls_the_rest_earlier",
    );
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    // `a` ends at 5 authored and `b` is placed from 4.8: second 4.9 is in both.
    expect(clock.authoredAt("host", 4.9, "a")).toBeCloseTo(4.9, 9);
    expect(clock.authoredAt("host", 4.9, "b")).toBeCloseTo(5.1, 9);
    expect(clock.authoredAt("host", 4.9)).toBeCloseTo(5.1, 9);
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

  it("converts unhinted seconds before, between, after and on the edges of a shifted lane", () => {
    const c = CASES.find(
      (x) => x.name === "overlaps_add_up_across_a_chain_and_a_gap",
    );
    if (!c) throw new Error("missing case");
    const clock = buildRenderClock(rows(c));
    // a 0-4, b 4-8, c 8-11 and d 15-18 placed at 0, 3.7, 7.3 and 14.3.
    expect(clock.renderedAt("host", 3.9)).toBeCloseTo(3.9, 9);
    expect(clock.renderedAt("host", 6)).toBeCloseTo(5.7, 9);
    expect(clock.renderedAt("host", 11)).toBeCloseTo(10.3, 9);
    expect(clock.renderedAt("host", 16)).toBeCloseTo(15.3, 9);
    expect(clock.renderedAt("host", 30)).toBeCloseTo(29.3, 9);
    expect(clock.authoredAt("host", 5.7)).toBeCloseTo(6, 9);
    expect(clock.authoredAt("host", 12)).toBeCloseTo(12.7, 9);
    expect(clock.authoredAt("host", 29.3)).toBeCloseTo(30, 9);
  });
});
