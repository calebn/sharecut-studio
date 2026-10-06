/**
 * One fade or trim change to a clip edge: the value a nudge lands on, and the
 * save both the timeline handles (`useClipEdgeHandles`) and the phone peek
 * strip send.
 */
import { setClipFade, trimClipEdge } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import type { ClipRow, ProjectView } from "../types/project";
import { clampTrimSourceSec, type TrimEdge } from "./clipEdgePreview";
import type { ClipHandleStepKind } from "./clipHandleSteps";
import { clampFadeMs, edgeFadeMaxMs } from "./fadeLimits";

export type ClipEdgeChange =
  | { kind: "fade"; inMs: number; outMs: number }
  | { kind: "trim"; edge: TrimEdge; sourceSec: number };

/** The saved value of `clip`'s `kind` edge: fade ms, or the trim's source second. */
export function clipEdgeValue(
  clip: ClipRow,
  kind: ClipHandleStepKind,
  edge: TrimEdge,
): number {
  if (kind === "fade")
    return edge === "in" ? clip.fade_in_ms : clip.fade_out_ms;
  return edge === "in" ? clip.source_start : clip.source_end;
}

/**
 * `clip`'s edge moved by `steps` nudge steps (negative shortens a fade or
 * moves a trim earlier), clamped the way the handle drag clamps it; null when
 * the clamp leaves it where it is.
 */
export function nudgeClipEdge(
  project: ProjectView,
  clip: ClipRow,
  kind: ClipHandleStepKind,
  edge: TrimEdge,
  delta: number,
): ClipEdgeChange | null {
  const track = project.tracks.find((t) => t.id === clip.track_id);
  if (kind === "fade") {
    const other = edge === "in" ? clip.fade_out_ms : clip.fade_in_ms;
    const ms = clampFadeMs(
      clipEdgeValue(clip, "fade", edge) + delta,
      edgeFadeMaxMs(
        clip.source_end - clip.source_start,
        track?.fade_max_ms ?? null,
        other,
      ),
    );
    if (ms === clipEdgeValue(clip, "fade", edge)) return null;
    return edge === "in"
      ? { kind: "fade", inMs: ms, outMs: clip.fade_out_ms }
      : { kind: "fade", inMs: clip.fade_in_ms, outMs: ms };
  }
  const lane = project.clips.tracks[clip.track_id] ?? [];
  const index = lane.findIndex((row) => row.id === clip.id);
  const sourceSec = clampTrimSourceSec(
    edge,
    clipEdgeValue(clip, "trim", edge) + delta,
    clip.source_start,
    clip.source_end,
    lane[index - 1]?.source_end ?? 0,
    lane[index + 1]?.source_start ?? track?.duration_sec ?? Infinity,
  );
  if (Math.abs(sourceSec - clipEdgeValue(clip, "trim", edge)) < 1e-9) {
    return null;
  }
  return { kind: "trim", edge, sourceSec };
}

/**
 * Saves `change` to `clip`; a trim ripples every dialogue track. Returns false
 * when nothing was saved: `fresh` turned false once the trim's boundary token
 * arrived (the trim is dropped unsent), or the ripple would cut another
 * speaker's speech and the host asked first (`CutSpeechDialog` resubmits it).
 */
export async function saveClipEdge(
  projectPath: string,
  clip: ClipRow,
  change: ClipEdgeChange,
  fresh: () => boolean = () => true,
): Promise<boolean> {
  if (change.kind === "fade") {
    await setClipFade(projectPath, clip.id, change.inMs, change.outMs);
    return true;
  }
  const { id, source_start, source_end, timeline_start, source_id } = clip;
  const boundary = await loadBoundaryContext(
    projectPath,
    { kind: "trim", clip_id: id, edge: change.edge },
    [{ id, source_start, source_end, timeline_start, source_id }],
  );
  if (!fresh()) return false;
  const { asked } = await trimClipEdge(
    projectPath,
    id,
    change.edge,
    change.sourceSec,
    "ripple",
    boundary.token,
  );
  return !asked;
}
