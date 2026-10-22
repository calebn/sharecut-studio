import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeLikeRender } from "../audio/renderClock";
import { clipRow } from "../test/fixtures";
import { JOIN_GAP_TOLERANCE_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";
import {
  clipIdsBeforeCut,
  clipsAbut,
  cutFadeHint,
  isCrossfadeJoin,
  isCutJoin,
  isDrawnJoin,
  JOIN_GLYPHS,
  JOIN_MODE_OPTIONS,
  JOIN_MODE_SHORT,
  joinDraftOverlapMs,
  joinGlyph,
  joinLengthMs,
  joinModeLabel,
  joinRenderNote,
  joinSeamLabel,
  joinVisual,
  joinWaveSpans,
  MIN_JOIN_CLIP_PX,
  MIN_JOIN_WAVE_CSS_PX,
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

  it("exposes the gap tolerance and minimum on-screen width", () => {
    expect(JOIN_GAP_TOLERANCE_SEC).toBe(0.05);
    expect(MIN_JOIN_CLIP_PX).toBe(24);
  });

  it("treats an abutment within tolerance (or an overlap) as touching", () => {
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 2.05 })).toBe(true);
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 1.9 })).toBe(true);
    expect(clipsAbut({ timeline_end: 2 }, { timeline_start: 2.051 })).toBe(
      false,
    );
  });

  it("draws a join only for abutting neighbours wide enough on screen", () => {
    expect(isDrawnJoin(null, clip, 50)).toBe(false);
    expect(isDrawnJoin(undefined, clip, 50)).toBe(false);
    expect(isDrawnJoin(left, clip, 50)).toBe(true);
    expect(isDrawnJoin(left, { ...clip, join_left_clip_id: "cx" }, 50)).toBe(
      false,
    );
    expect(isDrawnJoin(left, { ...clip, join_left_clip_id: null }, 50)).toBe(
      false,
    );
    const { join_left_clip_id: _drop, ...older } = clip;
    expect(isDrawnJoin(left, older, 50)).toBe(true);
    expect(
      isDrawnJoin(left, { ...clip, timeline_start: 3, timeline_end: 5 }, 50),
    ).toBe(false);
    const narrowRight = { ...clip, source_end: 0.4 };
    expect(isDrawnJoin(left, narrowRight, 50)).toBe(false);
    expect(isDrawnJoin(left, narrowRight, 60)).toBe(true);
  });

  it("picks the glyph from the join mode, defaulting to fade", () => {
    expect(joinGlyph({ join_in_mode: "cut" })).toBe("cut");
    expect(joinGlyph({ join_in_mode: "fade" })).toBe("fade");
    expect(joinGlyph({ join_in_mode: "crossfade" })).toBe("crossfade");
    expect(joinGlyph({ join_in_mode: "weird" })).toBe("fade");
  });

  it("has a short word for each glyph", () => {
    expect(JOIN_MODE_SHORT).toEqual({
      cut: "Cut",
      fade: "Fade",
      crossfade: "Crossfade",
    });
  });

  it("orders the popover's glyphs cut, fade, crossfade", () => {
    expect(JOIN_GLYPHS).toEqual(["cut", "fade", "crossfade"]);
  });

  it("names the seam by mode and time", () => {
    expect(joinSeamLabel("fade", 5)).toBe("Fade join at 0:05.0");
    expect(joinSeamLabel("crossfade", 0)).toBe("Crossfade join at 0:00.0");
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
        ({ ...row, source_id: null, recording_key: null }) as ClipRow,
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
