import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import {
  clipIdsBeforeCut,
  cutFadeHint,
  isCrossfadeJoin,
  isCutJoin,
  JOIN_MODE_OPTIONS,
  joinModeLabel,
  joinRenderNote,
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
    expect(isCutJoin({ join_in_mode: "cut" })).toBe(true);
    expect(isCutJoin({ join_in_mode: "fade" })).toBe(false);
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
