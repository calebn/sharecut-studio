import { JOIN_GAP_TOLERANCE_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";
import {
  JOIN_MODE_OPTIONS,
  type JoinMarkerKind,
  joinKind,
  markerLabel,
} from "../utils/editMarkerRegistry";
import { formatRulerTime } from "../utils/time";

export function joinModeLabel(mode: string): string {
  return JOIN_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

const BLOCKED_REASON: Record<string, string> = {
  not_abutting: "the clips do not touch",
  no_fade_out: "the left clip has no fade-out",
  no_fade_in: "this clip has no fade-in",
  no_headroom: "the recordings have no room past the cut to overlap",
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

type JoinClip = Pick<
  ClipRow,
  "id" | "timeline_start" | "timeline_end" | "join_left_clip_id"
>;

/** `clips_ops.clips_abut`: `right` starts within the join tolerance of `left`'s end (overlaps count). */
export function clipsAbut(
  left: Pick<ClipRow, "timeline_end">,
  right: Pick<ClipRow, "timeline_start">,
): boolean {
  return right.timeline_start - left.timeline_end <= JOIN_GAP_TOLERANCE_SEC;
}

/** True when the timeline draws the join `left` → `right`: abutting neighbours whose join names `left` (older servers omit the id). */
export function isJoin(
  left: JoinClip | null | undefined,
  right: JoinClip,
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
  return clipsAbut(left, right);
}

/** Seconds of context either side of the seam when auditioning a join (inspector footer and popover). */
export const JOIN_AUDITION_PAD_SEC = 0.75;

/** "Fade join at 0:05.0": the join badge's name and the popover's title. */
export function joinSeamLabel(kind: JoinMarkerKind, seamSec: number): string {
  return `${markerLabel(kind)} join at ${formatRulerTime(seamSec, 0.1)}`;
}

/**
 * The join's current length (ms) for the popover slider: the overlap the two edge
 * fades ask for (`clips_ops.crossfade_ms_at_join`) while the crossfade blends,
 * else the longer of the two edge fades. It is the authored length, not the
 * overlap render settles on (`join_crossfade_ms`), so a short room or the 5 ms
 * steps never shrink the stored fades when the popover saves.
 */
export function joinLengthMs(
  left: Pick<ClipRow, "fade_out_ms">,
  right: Pick<ClipRow, "fade_in_ms" | "join_in_mode" | "join_crossfade_ms">,
): number {
  if (isCrossfadeJoin(right) && (right.join_crossfade_ms ?? 0) > 0) {
    const shorter = Math.min(left.fade_out_ms, right.fade_in_ms);
    const longer = Math.max(left.fade_out_ms, right.fade_in_ms);
    return Math.max(shorter, Math.floor(longer / 2));
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

export type JoinVisual =
  | { kind: "ordinary" }
  | { kind: "blocked"; reason: string }
  | { kind: "blend"; lengthMs: number; leftPx: number; widthPx: number };

export function joinVisual(
  right: Pick<
    ClipRow,
    | "join_in_mode"
    | "join_crossfade_blocked"
    | "join_crossfade_ms"
    | "timeline_start"
  >,
  zoomPxPerSec: number,
): JoinVisual {
  if (joinKind(right) !== "join-crossfade") return { kind: "ordinary" };
  if (right.join_crossfade_blocked != null)
    return { kind: "blocked", reason: right.join_crossfade_blocked };
  const lengthMs = right.join_crossfade_ms;
  if (lengthMs == null || !Number.isFinite(lengthMs) || lengthMs <= 0)
    return { kind: "ordinary" };
  const widthPx = (lengthMs * zoomPxPerSec) / 1000;
  return {
    kind: "blend",
    lengthMs,
    widthPx,
    leftPx: right.timeline_start * zoomPxPerSec - widthPx / 2,
  };
}

export const MIN_JOIN_WAVE_CSS_PX = 1;

export type JoinWaveSpans = {
  leftMediaStartSec: number;
  rightMediaStartSec: number;
  raster: boolean;
};

export function joinWaveSpans(
  left: Pick<ClipRow, "source_end">,
  right: Pick<ClipRow, "source_start">,
  visual: JoinVisual,
): JoinWaveSpans | null {
  if (visual.kind !== "blend") return null;
  const borrowSec = visual.lengthMs / 2000;
  return {
    leftMediaStartSec: left.source_end - borrowSec,
    rightMediaStartSec: right.source_start - borrowSec,
    raster: visual.widthPx >= MIN_JOIN_WAVE_CSS_PX,
  };
}

const BORROW_STEP_SEC = 0.005;
const MIN_BLEND_SEC = 0.02;
const BLEND_SLACK_SEC = 1e-9;
/** `clips_ops.SPLICE_SOURCE_EPS_SEC`: a source gap under this is a contiguous split. */
const SPLICE_SOURCE_EPS_SEC = 1e-4;

type DraftPick = Pick<
  ClipRow,
  "source_start" | "source_end" | "source_duration_sec"
> &
  Partial<Pick<ClipRow, "recording_key">>;

/**
 * `clips_ops._gap_room`: half the removed source span between two clips of one recording, else Infinity.
 * Draft-only difference: a null `recording_key` is uncapped here, whereas Python
 * treats two clips with the same (or both None) source id as one recording; the
 * browser has no server field to tell those apart.
 */
function gapRoom(left: DraftPick, right: DraftPick): number {
  if (left.recording_key == null || left.recording_key !== right.recording_key)
    return Infinity;
  const rawGap = right.source_start - left.source_end;
  // The raw comparison `is_splice` makes, before the 6 dp rounding.
  if (rawGap < SPLICE_SOURCE_EPS_SEC) return Infinity;
  return Math.round(rawGap * 1e6) / 1e6 / 2;
}

/**
 * The overlap (ms) render settles on for a draft length `ms`: the same room
 * and 5 ms steps as `clips_ops.crossfade_borrow_sec` / `renderClock.borrowSec`
 * (the recordings beyond both edges, a quarter of either clip, half the
 * removed source span between two clips of one recording), 0 when too
 * little room is left to blend or either recording is unmeasured.
 */
export function joinDraftOverlapMs(
  left: DraftPick,
  right: DraftPick,
  ms: number,
): number {
  if (left.source_duration_sec === null || right.source_duration_sec === null)
    return 0;
  const room = Math.min(
    right.source_start,
    (left.source_end - left.source_start) * 0.25,
    (right.source_end - right.source_start) * 0.25,
    left.source_duration_sec - left.source_end,
    gapRoom(left, right),
  );
  if (
    !(ms > 0) ||
    2 * room + BLEND_SLACK_SEC < Math.min(ms / 1000, MIN_BLEND_SEC)
  )
    return 0;
  const steps = Math.floor(
    Math.min(Math.max(ms / 2000, BORROW_STEP_SEC), room) / BORROW_STEP_SEC +
      1e-9,
  );
  return steps >= 1 ? Math.round(steps * BORROW_STEP_SEC * 2000) : 0;
}

export function projectJoinDraft(
  left: DraftPick,
  right: ClipRow,
  ms: number,
): ClipRow {
  if (joinKind(right) !== "join-crossfade") return right;
  // The browser cannot see mutes, so a saved no_headroom is kept for the drag.
  // It is length-curable only for a mute 5-10 ms past the edge (needs a ~20 ms
  // or shorter drag); a source gap under 20 ms is not curable by length.
  // Release re-reads the server row.
  if (
    right.join_crossfade_blocked === "no_headroom" ||
    right.join_crossfade_blocked === "not_abutting"
  )
    return right;
  return {
    ...right,
    join_crossfade_ms: joinDraftOverlapMs(left, right, ms),
    join_crossfade_blocked: null,
  };
}
