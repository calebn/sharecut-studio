import type { JoinMode, ProjectView } from "../types/project";
import { joinModeOf } from "../utils/editMarkerRegistry";
import { appliedJoinLength } from "./joinRender";
import type { Seam } from "./seam";

export type JoinTypeOption = {
  value: JoinMode;
  label: string;
};

export const JOIN_TYPE_OPTIONS: readonly JoinTypeOption[] = [
  { value: "cut", label: "Hard edge" },
  { value: "fade", label: "Fade" },
  { value: "crossfade", label: "Crossfade" },
];

export function joinTypeLabel(mode: JoinMode): string {
  return JOIN_TYPE_OPTIONS.find((option) => option.value === mode)?.label ?? "";
}

/** The types a seam can take now: a crossfade needs room and a fade on both sides, unless it already is one. */
export function joinTypeChoices(
  seam: Seam,
  project: ProjectView,
): readonly JoinTypeOption[] {
  const mode = joinModeOf(seam.right);
  const fadeMax =
    project.tracks.find((t) => t.id === seam.trackId)?.fade_max_ms ?? null;
  const room = appliedJoinLength(seam.left, seam.right, fadeMax).max;
  const crossfadeOk = !seam.right.join_crossfade_blocked && room >= 1;
  return JOIN_TYPE_OPTIONS.filter(
    (option) =>
      option.value !== "crossfade" || crossfadeOk || mode === "crossfade",
  );
}
