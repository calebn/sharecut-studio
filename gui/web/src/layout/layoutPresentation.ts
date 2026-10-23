import type { LayoutMode, ShellBreakpoint } from "../state/types";

export type EffectiveLayoutMode = Exclude<LayoutMode, "adaptive">;

export const SHORT_TOUCH_LANDSCAPE_MQ =
  "(pointer: coarse) and (orientation: landscape) and (max-height: 35rem)";

export function readShortTouchLandscape(): boolean {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(SHORT_TOUCH_LANDSCAPE_MQ).matches
  );
}

export function resolveLayoutMode(
  requested: LayoutMode,
  shell: ShellBreakpoint,
  shortTouchLandscape: boolean,
): EffectiveLayoutMode {
  if (requested !== "adaptive") return requested;
  return shell === "tablet" && shortTouchLandscape ? "timeline" : "default";
}
