import {
  type BoundaryGeometryClip,
  loadBoundaryContext,
  restoreAppliedEdit,
  rollClipJoin,
  setClipJoin,
} from "../api";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { appliedJoinLength } from "../edit/joinRender";
import { rollJoinInterval } from "../edit/rollLimits";
import { type CutSeam, keepPlan, type Seam, seamById } from "../edit/seam";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import { inspectorOpenFor } from "../state/selection";
import type { JoinMode } from "../types/project";
import { ApiError, errorMessage } from "../utils/apiError";
import { joinModeOf } from "../utils/editMarkerRegistry";
import { playSpan } from "./playSpan";
import type { ExecuteResult } from "./types";

export const HEAR_ACROSS_SEC = 2;
export const EDITING_OFF_REASON = "Editing is off for this link";

export type SeamCommit =
  | { status: "done" }
  | { status: "skipped" }
  | { status: "failed"; message: string };

const SKIPPED: SeamCommit = { status: "skipped" };

export const ROLL_CONFLICT_MESSAGE =
  "The seam moved before the roll saved. Nothing changed.";
const MIN_ROLL_MS = 0.05;

function rollFailure(error: unknown): string {
  return error instanceof ApiError && error.code === "document_conflict"
    ? ROLL_CONFLICT_MESSAGE
    : errorMessage(error);
}

export function hearAcross(seam: Seam): ExecuteResult {
  return playSpan(
    Math.max(0, seam.joinSec - HEAR_ACROSS_SEC),
    seam.joinSec + HEAR_ACROSS_SEC,
    0,
  );
}

export function replayIfInspected(seamId: string): void {
  const s = useDawStore.getState();
  const open =
    s.selection?.kind === "seam" &&
    s.selection.id === seamId &&
    inspectorOpenFor(s.selection, s.inspectorKey);
  const seam = s.project ? seamById(s.project, seamId) : null;
  if (open && seam && !s.isPlaying) hearAcross(seam);
}

export async function setSeamJoin(
  seam: Seam,
  mode: JoinMode,
  lengthMs: number | null,
): Promise<SeamCommit> {
  const store = useDawStore.getState();
  const { projectPath, projectEpoch, project } = store;
  if (
    !project ||
    !canApplyPass12(projectPath, store.guestMode, store.shareCapabilities) ||
    store.joinMutationInFlight
  ) {
    return SKIPPED;
  }
  const current = seamById(project, seam.id);
  if (!current) return SKIPPED;
  const { left, right } = current;
  const fadeMax =
    project.tracks.find((t) => t.id === current.trackId)?.fade_max_ms ?? null;
  const range = appliedJoinLength(left, right, fadeMax);
  let sent: number | null = null;
  if (mode === "crossfade") {
    if (range.max < 1 || right.join_crossfade_blocked) return SKIPPED;
    sent = Math.min(range.max, Math.max(1, lengthMs ?? range.saved));
  } else if (mode === "fade" && lengthMs != null) {
    sent = Math.min(range.max, Math.max(0, lengthMs));
  }
  if (mode === joinModeOf(right) && (sent == null || sent === range.saved)) {
    return SKIPPED;
  }
  store.setJoinMutationInFlight(true);
  try {
    await trackEditSave(
      projectPath,
      setClipJoin(projectPath, left.id, right.id, mode, sent),
    );
    return { status: "done" };
  } catch (error) {
    const message = errorMessage(error);
    if (useDawStore.getState().projectEpoch === projectEpoch) {
      useDawStore.getState().announceStatus(message, { tone: "error" });
    }
    return { status: "failed", message };
  } finally {
    if (useDawStore.getState().projectEpoch === projectEpoch) {
      useDawStore.getState().setJoinMutationInFlight(false);
    }
  }
}

export function seamGeometry({ left, right }: Seam): BoundaryGeometryClip[] {
  return [left, right].map(
    ({ id, source_start, source_end, timeline_start, source_id }) => ({
      id,
      source_start,
      source_end,
      timeline_start,
      source_id,
    }),
  );
}

export async function rollSeam(
  seam: Seam,
  deltaMs: number,
): Promise<SeamCommit> {
  const store = useDawStore.getState();
  const { projectPath, projectEpoch, project } = store;
  if (
    !project ||
    !canApplyPass12(projectPath, store.guestMode, store.shareCapabilities) ||
    store.joinMutationInFlight ||
    Math.abs(deltaMs) < MIN_ROLL_MS
  ) {
    return SKIPPED;
  }
  const live = rollJoinInterval(
    project.clips.tracks[seam.trackId] ?? [],
    seam.left.id,
    seam.right.id,
  );
  if (!live) return SKIPPED;
  const { left, right } = seam;
  store.setJoinMutationInFlight(true);
  try {
    const queued = await trackEditSave(
      projectPath,
      (async () => {
        const context = await loadBoundaryContext(
          projectPath,
          { kind: "roll", left_clip_id: left.id, right_clip_id: right.id },
          seamGeometry(seam),
        );
        const now = useDawStore.getState();
        if (
          now.projectPath !== projectPath ||
          now.projectEpoch !== projectEpoch
        )
          throw new Error("The project changed during the roll");
        return rollClipJoin(
          projectPath,
          left.id,
          right.id,
          deltaMs / 1000,
          context.token,
        );
      })(),
    );
    return queued.queued ? SKIPPED : { status: "done" };
  } catch (error) {
    return { status: "failed", message: rollFailure(error) };
  } finally {
    if (useDawStore.getState().projectEpoch === projectEpoch) {
      useDawStore.getState().setJoinMutationInFlight(false);
    }
  }
}

function restoredMessage(seam: CutSeam, trackCount: number): string {
  const length =
    seam.removedSec > 0 ? `${seam.removedSec.toFixed(1)} s` : "cut";
  return trackCount > 1
    ? `Restored ${length} on ${trackCount} tracks`
    : `Restored ${length}`;
}

export async function restoreSeam(seam: CutSeam): Promise<ExecuteResult> {
  const store = useDawStore.getState();
  const { projectPath, projectEpoch, project } = store;
  if (
    !project ||
    !canApplyPass12(projectPath, store.guestMode, store.shareCapabilities)
  ) {
    return { status: "disabled", reason: EDITING_OFF_REASON };
  }
  const current = seamById(project, seam.id);
  if (current?.kind !== "cut") {
    return { status: "disabled", reason: "Nothing was cut here" };
  }
  const plan = keepPlan(current);
  if (plan.kind === "disabled") {
    return { status: "disabled", reason: plan.reason };
  }
  try {
    await trackEditSave(projectPath, restoreAppliedEdit(projectPath, plan.ids));
  } catch (error) {
    const reason = errorMessage(error);
    if (useDawStore.getState().projectEpoch === projectEpoch) {
      await refreshDocumentProject(projectPath).catch(() => undefined);
      useDawStore.getState().announceStatus(reason, { tone: "error" });
    }
    return { status: "disabled", reason, told: true };
  }
  const live = useDawStore.getState();
  if (live.projectEpoch === projectEpoch) {
    live.setSelection(null);
    live.announceStatus(restoredMessage(current, plan.trackCount));
  }
  return { status: "ok" };
}
