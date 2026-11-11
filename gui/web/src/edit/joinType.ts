import type { JoinMode } from "../types/project";
import { joinModeOf } from "../utils/editMarkerRegistry";
import { appliedJoinLength } from "./joinRender";
import type { Seam } from "./seam";

export const JOIN_TYPE_OPTIONS = [
  { value: "cut", label: "Hard edge", icon: "minus" },
  { value: "fade", label: "Fade", icon: "fade" },
  { value: "crossfade", label: "Crossfade", icon: "crossfade" },
] as const satisfies readonly {
  value: JoinMode;
  label: string;
  icon: string;
}[];

export type JoinTypeOption = (typeof JOIN_TYPE_OPTIONS)[number];

export const JOIN_MODES: readonly JoinMode[] = JOIN_TYPE_OPTIONS.map(
  (option) => option.value,
);

export function joinTypeLabel(mode: JoinMode): string {
  return JOIN_TYPE_OPTIONS.find((option) => option.value === mode)?.label ?? "";
}

function crossfadeAvailable(seam: Seam): boolean {
  const room = appliedJoinLength(seam.left, seam.right).max;
  return !seam.right.join_crossfade_blocked && room >= 1;
}

export function joinTypeChoices(seam: Seam): readonly JoinTypeOption[] {
  const mode = joinModeOf(seam.right);
  const crossfadeOk = crossfadeAvailable(seam);
  return JOIN_TYPE_OPTIONS.filter(
    (option) =>
      option.value !== "crossfade" || crossfadeOk || mode === "crossfade",
  );
}
