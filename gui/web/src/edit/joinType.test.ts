import { describe, expect, it } from "vitest";
import { clipRow, editBoundaries, minimalProject } from "../test/fixtures";
import { JOIN_TYPE_OPTIONS, joinTypeChoices, joinTypeLabel } from "./joinType";
import { seamsOnTrack } from "./seam";

function seamWith(rightOverrides: Parameters<typeof clipRow>[0]) {
  const lane = [
    clipRow({
      id: "a",
      track_id: "host",
      source_start: 0,
      source_end: 2,
      timeline_start: 0,
      timeline_end: 2,
      fade_out_ms: 50,
    }),
    clipRow({
      id: "b",
      track_id: "host",
      source_start: 2,
      source_end: 4,
      timeline_start: 2,
      timeline_end: 4,
      fade_in_ms: 50,
      join_left_clip_id: "a",
      ...rightOverrides,
    }),
  ];
  const project = minimalProject({
    clips: { tracks: { host: lane }, clip_count: 2 },
    edit_boundaries: editBoundaries(lane),
  });
  const seam = seamsOnTrack(project, "host")[0];
  if (!seam) throw new Error("no seam");
  return { seam, project };
}

describe("join type", () => {
  it("lists Hard edge, Fade and Crossfade in that order", () => {
    expect(JOIN_TYPE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["cut", "Hard edge"],
      ["fade", "Fade"],
      ["crossfade", "Crossfade"],
    ]);
    expect(joinTypeLabel("cut")).toBe("Hard edge");
  });

  it("offers all three where the clips can overlap", () => {
    const { seam, project } = seamWith({});
    expect(joinTypeChoices(seam, project).map((o) => o.value)).toEqual([
      "cut",
      "fade",
      "crossfade",
    ]);
  });

  it("leaves Crossfade out when the server says it is blocked", () => {
    const { seam, project } = seamWith({
      join_crossfade_blocked: "no_fade_in",
    });
    expect(joinTypeChoices(seam, project).map((o) => o.value)).toEqual([
      "cut",
      "fade",
    ]);
  });

  it("keeps Crossfade when the join already is one, even if blocked", () => {
    const { seam, project } = seamWith({
      join_in_mode: "crossfade",
      join_crossfade_blocked: "no_fade_in",
    });
    expect(joinTypeChoices(seam, project).map((o) => o.value)).toContain(
      "crossfade",
    );
  });
});
