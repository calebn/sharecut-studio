import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeLikeRender } from "../audio/renderClock";
import { clipRow } from "../test/fixtures";
import { JOIN_GAP_TOLERANCE_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";
import { JOIN_MODE_OPTIONS } from "../utils/editMarkerRegistry";
import {
  clipIdsBeforeCut,
  clipsAbut,
  cutFadeHint,
  drawnOverlapPx,
  isCrossfadeJoin,
  isCutJoin,
  isJoin,
  joinDraftOverlapMs,
  joinLengthMs,
  joinModeLabel,
  joinRenderNote,
  joinSeamLabel,
  joinTier,
  joinVisual,
  joinWaveSpans,
  MIN_JOIN_WAVE_CSS_PX,
  projectJoinDraft,
} from "./joinRender";

const clip: ClipRow = {
  id: "c2",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 2,
  timeline_end: 4,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  join_left_clip_id: "c1",
  join_render_mode: "fade",
  join_crossfade_ms: 0,
  join_crossfade_blocked: null,
  source_id: null,
  source_duration_sec: null,
  recording_key: null,
};

describe("joinRender", () => {
  it("labels every mode in human terms", () => {
    expect(JOIN_MODE_OPTIONS.map((o) => o.value)).toEqual([
      "cut",
      "fade",
      "crossfade",
    ]);
    expect(joinModeLabel("crossfade")).toBe("Crossfade (overlap both clips)");
    expect(joinModeLabel("weird")).toBe("weird");
  });

  it("describes what render does", () => {
    expect(joinRenderNote({ ...clip, join_left_clip_id: null })).toBeNull();
    expect(joinRenderNote({ ...clip, join_in_mode: "cut" })).toBe(
      "Renders as a hard cut: the fades at this join are ignored.",
    );
    expect(joinRenderNote(clip)).toMatch(/fade at the join/);
    expect(
      joinRenderNote({
        ...clip,
        join_in_mode: "crossfade",
        join_render_mode: "crossfade",
        join_crossfade_ms: 25,
      }),
    ).toBe("Renders as a 25 ms crossfade overlap.");
    expect(
      joinRenderNote({
        ...clip,
        join_in_mode: "crossfade",
        join_crossfade_blocked: "no_fade_in",
      }),
    ).toMatch(/no fade-in/);
  });
});

describe("join mode helpers", () => {
  it("finds clips whose next join is a cut", () => {
    const ids = clipIdsBeforeCut([
      { join_in_mode: "fade", join_left_clip_id: null },
      { join_in_mode: "cut", join_left_clip_id: "c1" },
      { join_in_mode: "fade", join_left_clip_id: "c2" },
      { join_in_mode: "cut", join_left_clip_id: null },
    ]);
    expect([...ids]).toEqual(["c1"]);
  });

  it("classifies join modes", () => {
    expect(isCutJoin({ join_in_mode: "cut", join_left_clip_id: "c1" })).toBe(
      true,
    );
    expect(isCutJoin({ join_in_mode: "fade", join_left_clip_id: "c1" })).toBe(
      false,
    );
    expect(isCutJoin({ join_in_mode: "cut", join_left_clip_id: null })).toBe(
      false,
    );
    expect(isCutJoin({ join_in_mode: "cut" })).toBe(false);
    expect(isCrossfadeJoin({ join_in_mode: "crossfade" })).toBe(true);
    expect(isCrossfadeJoin({ join_in_mode: "cut" })).toBe(false);
  });

  it("words the cut-fade hint per edge", () => {
    expect(cutFadeHint(false, false)).toBeNull();
    expect(cutFadeHint(true, false)).toMatch(/Fade in ignored/);
    expect(cutFadeHint(false, true)).toMatch(/Fade out ignored/);
    expect(cutFadeHint(true, true)).toMatch(/both joins/);
  });
});

describe("drawn joins", () => {
  const left: ClipRow = {
    ...clip,
    id: "c1",
    timeline_start: 0,
    timeline_end: 2,
    join_left_clip_id: null,
  };

  it("exposes the gap tolerance", () => {
    expect(JOIN_GAP_TOLERANCE_SEC).toBe(0.05);
  });

  it("treats an abutment within tolerance (or an overlap) as touching", () => {
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 2.05 })).toBe(true);
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 1.9 })).toBe(true);
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 2.051 })).toBe(
      false,
    );
  });

  it("draws a join for any abutting neighbours at any zoom", () => {
    expect(isJoin(null, clip)).toBe(false);
    expect(isJoin(undefined, clip)).toBe(false);
    expect(isJoin(left, clip)).toBe(true);
    expect(isJoin(left, { ...clip, join_left_clip_id: "cx" })).toBe(false);
    expect(isJoin(left, { ...clip, join_left_clip_id: null })).toBe(false);
    const { join_left_clip_id: _drop, ...older } = clip;
    expect(isJoin(left, older)).toBe(true);
    expect(isJoin(left, { ...clip, timeline_start: 3, timeline_end: 5 })).toBe(
      false,
    );
    const sliver = { ...clip, source_end: 0.001 };
    expect(isJoin(left, sliver)).toBe(true);
  });

  it("names the seam by mode and time", () => {
    expect(joinSeamLabel("join-fade", 5)).toBe("Fade join at 0:05.0");
    expect(joinSeamLabel("join-crossfade", 0)).toBe("Crossfade join at 0:00.0");
  });

  it("reads the join's current length for the popover slider", () => {
    expect(
      joinLengthMs(
        { fade_out_ms: 10 },
        { fade_in_ms: 20, join_in_mode: "fade" },
      ),
    ).toBe(20);
    expect(
      joinLengthMs(
        { fade_out_ms: 25 },
        {
          fade_in_ms: 25,
          join_in_mode: "crossfade",
          join_crossfade_ms: 20,
        },
      ),
    ).toBe(25);
    expect(
      joinLengthMs(
        { fade_out_ms: 10 },
        {
          fade_in_ms: 60,
          join_in_mode: "crossfade",
          join_crossfade_ms: 30,
        },
      ),
    ).toBe(30);
    expect(
      joinLengthMs(
        { fade_out_ms: 10 },
        {
          fade_in_ms: 20,
          join_in_mode: "crossfade",
          join_crossfade_ms: 0,
        },
      ),
    ).toBe(20);
    expect(
      joinLengthMs(
        { fade_out_ms: 10 },
        {
          fade_in_ms: 20,
          join_in_mode: "crossfade",
          join_crossfade_ms: undefined,
        },
      ),
    ).toBe(20);
  });
});

describe("joinVisual authoritative overlap", () => {
  it("centers the exact derived span rather than either stored fade", () => {
    const right = clipRow({
      timeline_start: 5,
      join_in_mode: "crossfade",
      fade_in_ms: 80,
      join_crossfade_ms: 40,
    });
    expect(joinVisual(right, 50)).toEqual({
      kind: "blend",
      lengthMs: 40,
      widthPx: 2,
      leftPx: 249,
    });
    expect(joinVisual(right, 100)).toEqual({
      kind: "blend",
      lengthMs: 40,
      widthPx: 4,
      leftPx: 498,
    });
  });
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not substitute raw fades for %s",
    (length) => {
      expect(
        joinVisual(
          clipRow({
            join_in_mode: "crossfade",
            fade_in_ms: 100,
            join_crossfade_ms: length,
          }),
          50,
        ),
      ).toEqual({ kind: "ordinary" });
    },
  );
  it("lets a blocked reason win over a contradictory positive projection", () => {
    expect(
      joinVisual(
        clipRow({
          join_in_mode: "crossfade",
          join_crossfade_ms: 50,
          join_crossfade_blocked: "no_fade_in",
        }),
        50,
      ),
    ).toEqual({ kind: "blocked", reason: "no_fade_in" });
  });
});

describe("joinWaveSpans pinned to the render clock", () => {
  const cases = (
    JSON.parse(
      readFileSync(
        `${process.cwd()}/../../tests/fixtures/render_clock/cases.json`,
        "utf8",
      ),
    ) as { cases: { name: string; clips: Record<string, unknown>[] }[] }
  ).cases;
  const pairs = cases.flatMap((c) => {
    const rows = c.clips.map(
      ({ placed_start: _p, ...row }) =>
        ({ source_id: null, recording_key: null, ...row }) as ClipRow,
    );
    const { borrowIn } = placeLikeRender(rows);
    return rows.flatMap((right, i) => {
      const left = rows[i - 1];
      return left && right.join_in_mode === "crossfade"
        ? [{ name: `${c.name}/${right.id}`, left, right, borrowIn }]
        : [];
    });
  });

  it.each(pairs)(
    "starts both layers one render borrow before the seam edges: $name",
    ({ left, right, borrowIn }) => {
      const borrow = borrowIn.get(right.id) ?? 0;
      const visual = joinVisual(right, 200);
      const spans = joinWaveSpans(left, right, visual);
      if (borrow === 0) {
        expect(visual.kind).not.toBe("blend");
        expect(spans).toBeNull();
        return;
      }
      if (visual.kind !== "blend") throw new Error("expected a blend");
      expect(visual.widthPx).toBeCloseTo(2 * borrow * 200, 9);
      expect(spans?.leftMediaStartSec).toBeCloseTo(left.source_end - borrow, 9);
      expect(spans?.rightMediaStartSec).toBeCloseTo(
        right.source_start - borrow,
        9,
      );
      expect(visual.leftPx + visual.widthPx / 2).toBeCloseTo(
        right.timeline_start * 200,
        9,
      );
    },
  );

  it("follows a draft length and flags sub-pixel overlaps as hairline only", () => {
    const right = clipRow({
      source_start: 5,
      timeline_start: 5,
      join_in_mode: "crossfade",
      join_crossfade_ms: 20,
    });
    const left = clipRow({ source_end: 5 });
    const hair = joinWaveSpans(left, right, joinVisual(right, 40));
    expect(hair?.raster).toBe(false);
    const wide = joinWaveSpans(
      left,
      right,
      joinVisual({ ...right, join_crossfade_ms: 400 }, 40),
    );
    expect(wide).toEqual({
      leftMediaStartSec: 4.8,
      rightMediaStartSec: 4.8,
      raster: true,
    });
    expect(MIN_JOIN_WAVE_CSS_PX).toBe(1);
  });

  it.each([
    clipRow({ join_in_mode: "cut" }),
    clipRow({ join_in_mode: "fade", join_crossfade_ms: 200 }),
    clipRow({
      join_in_mode: "crossfade",
      join_crossfade_ms: 200,
      join_crossfade_blocked: "no_headroom",
    }),
    clipRow({ join_in_mode: "crossfade", join_crossfade_ms: 0 }),
  ])("draws nothing for a cut, fade, blocked or zero-length join", (right) => {
    expect(joinWaveSpans(clipRow(), right, joinVisual(right, 200))).toBeNull();
  });
});

describe("joinDraftOverlapMs", () => {
  const left = { source_start: 0, source_end: 5, source_duration_sec: 100 };
  const right = { source_start: 5, source_end: 10, source_duration_sec: 100 };

  it("keeps a length the recordings can hold, in 10 ms overlap steps", () => {
    expect(joinDraftOverlapMs(left, right, 420)).toBe(420);
    expect(joinDraftOverlapMs(left, right, 423)).toBe(420);
  });

  it("caps at twice the room: a quarter of either clip and the recording ends", () => {
    expect(joinDraftOverlapMs(left, right, 9000)).toBe(2500);
    expect(
      joinDraftOverlapMs(left, { ...right, source_start: 0.05 }, 400),
    ).toBe(100);
    expect(
      joinDraftOverlapMs({ ...left, source_duration_sec: 5.03 }, right, 400),
    ).toBe(60);
  });

  it("is 0 when there is too little room to blend", () => {
    expect(
      joinDraftOverlapMs(left, { ...right, source_start: 0.005 }, 400),
    ).toBe(0);
    expect(joinDraftOverlapMs(left, right, 0)).toBe(0);
  });

  it("is 0 when the left recording's length is unmeasured, as render blocks the join", () => {
    expect(
      joinDraftOverlapMs({ ...left, source_duration_sec: null }, right, 400),
    ).toBe(0);
  });

  it("is 0 when the right recording's length is unmeasured, as render blocks the join", () => {
    expect(
      joinDraftOverlapMs(left, { ...right, source_duration_sec: null }, 400),
    ).toBe(0);
  });
});

describe("joinDraftOverlapMs caps the borrow at half the source gap", () => {
  const KEY = "rec-fixture-a";
  const left = {
    source_start: 1,
    source_end: 4,
    source_duration_sec: 10,
    recording_key: KEY,
  };
  const at = (gapMs: number, key: string | null = KEY) => ({
    source_start: 4 + gapMs / 1000,
    source_end: 7 + gapMs / 1000,
    source_duration_sec: 10,
    recording_key: key,
  });

  // [gap ms, requested overlap ms, overlap ms drawn]: same table as
  // test_a_cut_gap_caps_the_borrow_at_half_the_gap in tests/test_clip_join.py.
  it.each([
    [10, 20, 0],
    [20, 20, 20],
    [20, 40, 20],
    [30, 60, 30],
    [80, 200, 80],
    [200, 400, 200],
    [300, 400, 300],
    [400, 400, 400],
  ])("a %i ms gap with a %i ms blend overlaps %i ms", (gap, ms, want) => {
    expect(joinDraftOverlapMs(left, at(gap), ms)).toBe(want);
  });

  it("does not let the float gap 0.3 - 0.28 fail the 20 ms minimum", () => {
    const right = { ...at(0), source_start: 4.3, source_end: 7.3 };
    const l = { ...left, source_end: 4.28 };
    expect(joinDraftOverlapMs(l, right, 40)).toBe(20);
  });

  it.each([0, 0.05, -0.05])(
    "leaves a contiguous join (%f ms) uncapped",
    (g) => {
      expect(joinDraftOverlapMs(left, at(g), 400)).toBe(400);
    },
  );

  it("leaves a raw gap just under 1e-4 uncapped, as is_splice sees it", () => {
    const right = { ...at(0), source_start: 4 + 9.9999999997e-5 };
    expect(right.source_start - left.source_end).toBeLessThan(1e-4);
    expect(joinDraftOverlapMs(left, right, 400)).toBe(400);
  });

  it("caps a gap of 1e-4 plus a tiny amount", () => {
    const right = { ...at(0), source_start: 4 + 1.0e-4 + 1e-8 };
    expect(right.source_start - left.source_end).toBeGreaterThanOrEqual(1e-4);
    expect(joinDraftOverlapMs(left, right, 400)).toBe(0);
  });

  it.each([-100, -1000, -3000])("leaves a %i ms negative gap uncapped", (g) => {
    expect(joinDraftOverlapMs(left, at(g), 400)).toBe(400);
  });

  it("leaves clips of different recordings uncapped", () => {
    expect(joinDraftOverlapMs(left, at(300, "rec_other"), 400)).toBe(400);
    expect(
      joinDraftOverlapMs({ ...left, recording_key: null }, at(300), 400),
    ).toBe(400);
    expect(joinDraftOverlapMs(left, at(300, null), 400)).toBe(400);
  });

  it("keeps the quarter-clip cap when it is smaller than the gap cap", () => {
    const short = { ...left, source_start: 3.6 };
    expect(joinDraftOverlapMs(short, at(300), 400)).toBe(200);
  });

  it("agrees with the server's join_crossfade_ms in the cut-gap fixture cases", () => {
    const cases = (
      JSON.parse(
        readFileSync(
          `${process.cwd()}/../../tests/fixtures/render_clock/cases.json`,
          "utf8",
        ),
      ) as { cases: { name: string; clips: Record<string, unknown>[] }[] }
    ).cases.filter((c) => c.clips.some((r) => r.recording_key));
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      const rows = c.clips as unknown as ClipRow[];
      const right = rows[1];
      const xf = Math.max(
        Math.min(rows[0].fade_out_ms, right.fade_in_ms),
        Math.floor(Math.max(rows[0].fade_out_ms, right.fade_in_ms) / 2),
      );
      expect([c.name, joinDraftOverlapMs(rows[0], right, xf)]).toEqual([
        c.name,
        right.join_crossfade_ms,
      ]);
    }
  });
});

describe("projectJoinDraft", () => {
  const left = { source_start: 0, source_end: 5, source_duration_sec: 100 };
  const crossfade = clipRow({
    source_start: 5,
    source_end: 10,
    source_duration_sec: 100,
    fade_in_ms: 20,
    fade_out_ms: 30,
    join_in_mode: "crossfade",
    join_left_clip_id: "left",
    join_crossfade_ms: 20,
    join_crossfade_blocked: "no_fade_in",
  });
  it("projects a crossfade row to the capped draft overlap and clears the block", () => {
    const out = projectJoinDraft(left, crossfade, 9000);
    expect(out.join_crossfade_ms).toBe(2500);
    expect(out.join_crossfade_blocked).toBeNull();
  });
  it("keeps every other field of the row", () => {
    const out = projectJoinDraft(left, crossfade, 400);
    expect(out).toEqual({
      ...crossfade,
      join_crossfade_ms: 400,
      join_crossfade_blocked: null,
    });
    expect(out).not.toBe(crossfade);
  });
  it("projects an unmeasured left recording to a zero overlap", () => {
    const out = projectJoinDraft(
      { ...left, source_duration_sec: null },
      crossfade,
      400,
    );
    expect(out.join_crossfade_ms).toBe(0);
  });
  it.each(["cut", "fade"])("returns a %s row as is", (mode) => {
    const row = { ...crossfade, join_in_mode: mode } as ClipRow;
    expect(projectJoinDraft(left, row, 9000)).toBe(row);
  });
  it.each(["no_headroom", "not_abutting"] as const)(
    "returns a saved %s row unchanged however much clip room there is",
    (reason) => {
      const row = {
        ...crossfade,
        join_crossfade_ms: 0,
        join_crossfade_blocked: reason,
      };
      const out = projectJoinDraft(left, row, 400);
      expect(out).toEqual(row);
    },
  );
  it.each(["no_fade_in", "no_fade_out"] as const)(
    "still projects a saved %s row (a drag sets the fades)",
    (reason) => {
      const row = {
        ...crossfade,
        join_crossfade_ms: 0,
        join_crossfade_blocked: reason,
      };
      const out = projectJoinDraft(left, row, 400);
      expect(out.join_crossfade_blocked).toBeNull();
      expect(out.join_crossfade_ms).toBe(joinDraftOverlapMs(left, row, 400));
      expect(out.join_crossfade_ms).toBe(400);
    },
  );
});

describe("joinTier", () => {
  it.each([
    [0, "narrow"],
    [7.99, "narrow"],
    [8, "middle"],
    [24, "middle"],
    [24.01, "wide"],
    [400, "wide"],
  ] as const)("reads a %f px drawn overlap as %s", (px, tier) => {
    expect(joinTier(px)).toBe(tier);
  });

  it("tiers a 120 ms crossfade by its drawn width at the zoom", () => {
    const right = clipRow({
      join_in_mode: "crossfade",
      join_crossfade_ms: 120,
    });
    const tierAt = (zoom: number) =>
      joinTier(drawnOverlapPx(joinVisual(right, zoom)));
    expect(tierAt(66)).toBe("narrow");
    expect(tierAt(200)).toBe("middle");
    expect(tierAt(1000)).toBe("wide");
  });

  it("draws no overlap for a join that is not a blend", () => {
    expect(drawnOverlapPx({ kind: "ordinary" })).toBe(0);
    expect(drawnOverlapPx({ kind: "blocked", reason: "no_headroom" })).toBe(0);
  });
});
