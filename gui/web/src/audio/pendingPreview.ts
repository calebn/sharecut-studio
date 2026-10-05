import { hostFetch } from "../api/documentTransport";
import { rangeIsCurrent, rangeTargetsEqual } from "../edit/rangeSelection";
import {
  hasShareCapability,
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { DawStore } from "../state/types";
import type { PendingEditView, ProjectView } from "../types/project";
import { errorMessage, readApiError } from "../utils/apiError";
import type { PreviewMode } from "../utils/playRange";
import { parseWavHeader, wavDurationSec } from "./wavHeader";

export const PENDING_PREVIEW_STALE_REASON =
  "This edit changed while its preview rendered. Play it again.";

export type PendingPreviewOutcome =
  | { status: "ok" }
  | { status: "disabled"; reason: string }
  /** A newer preview or a release took over; nothing to report. */
  | { status: "superseded" };

type ActivePreview = {
  ownerId: string;
  controller: AbortController;
  url: string | null;
};

/** One server-rendered pending preview plays at a time, from any caller. */
let active: ActivePreview | null = null;

export function pendingPreviewOwnerId(editId: string): string {
  return `pending:${editId}`;
}

export function canPlayPendingPreview(
  state: Pick<DawStore, "guestMode" | "shareCapabilities">,
  projectPath: string,
): boolean {
  const guest = isShareProjectKey(projectPath) || state.guestMode !== null;
  return !guest || hasShareCapability(state.shareCapabilities, "play");
}

/** Why `mode` cannot play for `edit`, or null when the server can render it. */
export function pendingPreviewBlockReason(
  edit: Pick<PendingEditView, "mappable" | "suggest_reason">,
  mode: PreviewMode,
  canPlay: boolean,
): string | null {
  if (!canPlay) return "This share cannot play audio";
  if (!edit.mappable || mode !== "current") return edit.suggest_reason;
  return null;
}

function livePendingEdit(
  state: DawStore,
  projectPath: string,
  editId: string,
): PendingEditView | null {
  if (state.projectPath !== projectPath || !state.project) return null;
  const edit = state.project.pending_edits.find((item) => item.id === editId);
  if (!edit || edit.applied) return null;
  if (edit.exact_range && !rangeIsCurrent(state.project, edit.exact_range))
    return null;
  return edit;
}

function editBounds(edit: PendingEditView): string {
  return JSON.stringify([
    edit.type,
    edit.track_id,
    edit.track_ids ?? null,
    edit.scope ?? null,
    edit.source_start,
    edit.source_end,
    edit.timeline_start,
    edit.timeline_end,
  ]);
}

function sameEdit(left: PendingEditView, right: PendingEditView): boolean {
  if (left.exact_range || right.exact_range)
    return (
      !!left.exact_range &&
      !!right.exact_range &&
      rangeTargetsEqual(left.exact_range, right.exact_range)
    );
  return editBounds(left) === editBounds(right);
}

function mixKey(project: ProjectView): string {
  return JSON.stringify([
    project.tracks,
    project.clips,
    project.effects_by_track,
    project.envelopes,
  ]);
}

function stopActive(): void {
  if (!active) return;
  active.controller.abort();
  useDawStore.getState().releaseSourcePreview(active.ownerId);
  if (active.url) URL.revokeObjectURL(active.url);
  active = null;
}

/** Stop and free `editId`'s preview if it is the one playing or rendering. */
export function releasePendingPreview(editId: string): void {
  if (active?.ownerId === pendingPreviewOwnerId(editId)) stopActive();
}

/**
 * Fetch the server's Current / Suggested / A/B render around a pending edit
 * and play it as a source preview. Suggested is the edit approved on a
 * snapshot, so it carries the paced pad, fades and premix trim approval ships.
 */
export async function playPendingPreview(
  projectPath: string,
  editId: string,
  mode: PreviewMode,
): Promise<PendingPreviewOutcome> {
  const captured = useDawStore.getState();
  const edit = livePendingEdit(captured, projectPath, editId);
  if (!edit)
    return { status: "disabled", reason: PENDING_PREVIEW_STALE_REASON };
  const blocked = pendingPreviewBlockReason(
    edit,
    mode,
    canPlayPendingPreview(captured, projectPath),
  );
  if (blocked) return { status: "disabled", reason: blocked };
  const mix = mixKey(captured.project!);
  stopActive();
  const request: ActivePreview = {
    ownerId: pendingPreviewOwnerId(editId),
    controller: new AbortController(),
    url: null,
  };
  active = request;
  try {
    const query = new URLSearchParams({ edit_id: editId, mode });
    const guest = isShareProjectKey(projectPath);
    if (!guest) query.set("path", projectPath);
    const endpoint = guest
      ? `${reviewApiBase(shareTokenFromKey(projectPath)!)}/daw/pending-preview`
      : "/api/pending-preview";
    const response = await (guest ? fetch : hostFetch)(`${endpoint}?${query}`, {
      signal: request.controller.signal,
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const blob = await response.blob();
    const durationSec = wavDurationSec(
      parseWavHeader(await blob.arrayBuffer()),
    );
    if (request.controller.signal.aborted) return { status: "superseded" };
    const live = useDawStore.getState();
    const liveEdit = livePendingEdit(live, projectPath, editId);
    if (
      live.projectEpoch !== captured.projectEpoch ||
      live.guestMode !== captured.guestMode ||
      !liveEdit ||
      !sameEdit(edit, liveEdit) ||
      mixKey(live.project!) !== mix ||
      !canPlayPendingPreview(live, projectPath)
    )
      return { status: "disabled", reason: PENDING_PREVIEW_STALE_REASON };
    request.url = URL.createObjectURL(blob);
    live.beginSourcePreview({
      ownerId: request.ownerId,
      media: { kind: "rendered", url: request.url },
      startSec: 0,
      endSec: durationSec,
    });
    return { status: "ok" };
  } catch (error) {
    if (request.controller.signal.aborted) return { status: "superseded" };
    return { status: "disabled", reason: errorMessage(error) };
  }
}
