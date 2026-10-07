/**
 * One fade or trim change to a clip edge, and the save both the timeline
 * handles (`useClipEdgeHandles`) and the phone peek strip's nudges
 * (`edit/nudge.ts`) send.
 */
import { setClipFade, trimClipEdge } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import type { ClipRow } from "../types/project";
import type { EditMode, TrimEdge } from "./clipEdgePreview";

/**
 * The mode every clip-edge trim previews and saves with: one value, so a
 * drag's preview and its save never disagree. The Edges switch (#1138) will
 * set it.
 */
export const TRIM_MODE: EditMode = "ripple";

export type ClipEdgeChange =
  | { kind: "fade"; inMs: number; outMs: number }
  | { kind: "trim"; edge: TrimEdge; mode: EditMode; sourceSec: number };

/**
 * Saves `change` to `clip`; a ripple trim moves every dialogue track. Returns false
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
    { kind: "trim", clip_id: id, edge: change.edge, mode: change.mode },
    [{ id, source_start, source_end, timeline_start, source_id }],
  );
  if (!fresh()) return false;
  const { asked } = await trimClipEdge(
    projectPath,
    id,
    change.edge,
    change.sourceSec,
    change.mode,
    boundary.token,
  );
  return !asked;
}
