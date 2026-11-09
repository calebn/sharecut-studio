import { restoreAppliedEdit, setClipJoin } from "../api";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { appliedJoinLength } from "../edit/joinRender";
import { type CutSeam, keepPlan, type Seam, seamById } from "../edit/seam";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import type { JoinMode } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { joinModeOf } from "../utils/editMarkerRegistry";
import { playSpan } from "./playSpan";
import type { ExecuteResult } from "./types";

export const HEAR_ACROSS_SEC = 2;

export type SeamCommit =
  | { status: "done" }
  | { status: "skipped" }
  | { status: "failed"; message: string };

const SKIPPED: SeamCommit = { status: "skipped" };

export function hearAcross(seam: Seam): ExecuteResult {
  return playSpan(
    Math.max(0, seam.joinSec - HEAR_ACROSS_SEC),
    seam.joinSec + HEAR_ACROSS_SEC,
    0,
  );
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
    if (range.max < 1) return SKIPPED;
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
    return { status: "disabled", reason: "Editing is off for this link" };
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
