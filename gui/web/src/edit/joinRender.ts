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

/** True when render treats this clip's incoming join as a hard cut. */
export function isCutJoin(clip: Pick<ClipRow, "join_in_mode">): boolean {
  return clip.join_in_mode === "cut";
}

/** True when this clip's incoming join is set to crossfade (it may still be blocked). */
export function isCrossfadeJoin(clip: Pick<ClipRow, "join_in_mode">): boolean {
  return clip.join_in_mode === "crossfade";
}

/** Why inspector fade inputs are ignored at cut joins, or null. */
export function cutFadeHint(cutIn: boolean, cutOut: boolean): string | null {
  if (cutIn && cutOut) {
    return "Ignored: both joins are cuts";
  }
  if (cutIn) {
    return "Fade in ignored: the join into this clip is a cut";
  }
  if (cutOut) {
    return "Fade out ignored: the join after this clip is a cut";
  }
  return null;
}

/** One line on what render does at this clip's incoming join. */
export function joinRenderNote(clip: ClipRow): string | null {
  if (clip.join_left_clip_id == null) {
    return null;
  }
  if (isCutJoin(clip)) {
    return "Renders as a hard cut: the fades at this join are ignored.";
  }
  if (isCrossfadeJoin(clip)) {
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
