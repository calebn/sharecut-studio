import type { ClipRow, JoinMode } from "../types/project";

export const JOIN_MODE_OPTIONS: { value: JoinMode; label: string }[] = [
  { value: "cut", label: "Cut (no fade)" },
  { value: "fade", label: "Fade (dip at join)" },
  { value: "crossfade", label: "Crossfade (overlap both clips)" },
];

export function joinModeLabel(mode: string): string {
  return JOIN_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

const BLOCKED_REASON: Record<string, string> = {
  not_abutting: "the clips do not touch",
  no_fade_out: "the left clip has no fade-out",
  no_fade_in: "this clip has no fade-in",
};

/** One line on what render does at this clip's incoming join. */
export function joinRenderNote(clip: ClipRow): string | null {
  if (clip.join_left_clip_id == null) {
    return null;
  }
  if (clip.join_in_mode === "cut") {
    return "Renders as a hard cut: fades on both clips are ignored.";
  }
  if (clip.join_in_mode === "crossfade") {
    if (clip.join_crossfade_blocked) {
      const why =
        BLOCKED_REASON[clip.join_crossfade_blocked] ??
        clip.join_crossfade_blocked;
      return `Crossfade will not blend: ${why}. It renders as a plain join.`;
    }
    return `Renders as a ${clip.join_crossfade_ms ?? 0} ms crossfade overlap.`;
  }
  return "Renders as a fade at the join: each clip fades at its edge.";
}
