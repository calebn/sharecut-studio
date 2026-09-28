import type { ClipRow, JoinMode } from "../types/project";
import { formatRulerTime } from "../utils/time";

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

/** True when render treats this clip's incoming join as a hard cut (a track's first clip has no join). */
export function isCutJoin(
  clip: Pick<ClipRow, "join_in_mode" | "join_left_clip_id">,
): boolean {
  return clip.join_left_clip_id != null && clip.join_in_mode === "cut";
}

/** True when this clip's incoming join is set to crossfade (it may still be blocked). */
export function isCrossfadeJoin(clip: Pick<ClipRow, "join_in_mode">): boolean {
  return clip.join_in_mode === "crossfade";
}

/** Mirrors `edits/clips_ops.JOIN_GAP_TOLERANCE_SEC` (tests/test_clips_ops.py checks they match). */
export const JOIN_GAP_TOLERANCE_SEC = 0.05;

/** Neighbours narrower than this on screen get no drawn join (badge); the clip inspector's Join control still covers it. */
export const MIN_JOIN_CLIP_PX = 24;

type JoinClip = Pick<
  ClipRow,
  | "id"
  | "source_start"
  | "source_end"
  | "timeline_start"
  | "timeline_end"
  | "join_left_clip_id"
>;

/** `clips_ops.clips_abut`: `right` starts within the join tolerance of `left`'s end (overlaps count). */
export function clipsAbut(
  left: Pick<ClipRow, "timeline_end">,
  right: Pick<ClipRow, "timeline_start">,
): boolean {
  return right.timeline_start - left.timeline_end <= JOIN_GAP_TOLERANCE_SEC;
}

/**
 * True when the timeline draws the join `left` → `right` (#690): abutting
 * neighbours whose join names `left` (older servers omit the id), both at
 * least MIN_JOIN_CLIP_PX wide at `zoomPxPerSec`.
 */
export function isDrawnJoin(
  left: JoinClip | null | undefined,
  right: JoinClip,
  zoomPxPerSec: number,
): boolean {
  if (left == null) {
    return false;
  }
  if (
    right.join_left_clip_id !== undefined &&
    right.join_left_clip_id !== left.id
  ) {
    return false;
  }
  if (!clipsAbut(left, right)) {
    return false;
  }
  const narrowSec = Math.min(
    left.source_end - left.source_start,
    right.source_end - right.source_start,
  );
  return narrowSec * zoomPxPerSec >= MIN_JOIN_CLIP_PX;
}

export type JoinGlyph = "cut" | "fade" | "crossfade";

/** The badge glyph for `right`'s incoming join (an unknown mode reads as fade, as render treats it). */
export function joinGlyph(right: Pick<ClipRow, "join_in_mode">): JoinGlyph {
  if (right.join_in_mode === "cut") {
    return "cut";
  }
  return right.join_in_mode === "crossfade" ? "crossfade" : "fade";
}

/** Short mode words for the join badge (and the join popover). */
export const JOIN_MODE_SHORT: Record<JoinGlyph, string> = {
  cut: "Cut",
  fade: "Fade",
  crossfade: "Crossfade",
};

/** The join modes in popover order. */
export const JOIN_GLYPHS: readonly JoinGlyph[] = ["cut", "fade", "crossfade"];

/** Seconds of context either side of the seam when auditioning a join (inspector footer and popover). */
export const JOIN_AUDITION_PAD_SEC = 0.75;

/** "Fade join at 0:05.0": the join badge's name and the popover's title. */
export function joinSeamLabel(glyph: JoinGlyph, seamSec: number): string {
  return `${JOIN_MODE_SHORT[glyph]} join at ${formatRulerTime(seamSec, 0.1)}`;
}

/**
 * The join's current length (ms) for the popover slider: render's overlap for an
 * unblocked crossfade (`join_crossfade_ms`), else the longer of the two edge fades.
 */
export function joinLengthMs(
  left: Pick<ClipRow, "fade_out_ms">,
  right: Pick<ClipRow, "fade_in_ms" | "join_in_mode" | "join_crossfade_ms">,
): number {
  if (isCrossfadeJoin(right) && (right.join_crossfade_ms ?? 0) > 0) {
    return right.join_crossfade_ms as number;
  }
  return Math.max(left.fade_out_ms, right.fade_in_ms);
}

/** Ids of clips whose outgoing join is a cut (render drops their fade-out). */
export function clipIdsBeforeCut(
  clips: Pick<ClipRow, "join_in_mode" | "join_left_clip_id">[],
): Set<string> {
  const ids = new Set<string>();
  for (const c of clips) {
    if (isCutJoin(c) && c.join_left_clip_id) {
      ids.add(c.join_left_clip_id);
    }
  }
  return ids;
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
