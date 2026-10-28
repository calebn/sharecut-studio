import { useSyncExternalStore } from "react";
import { executePointerCommand } from "../commands/pointer";
import { editBasisKey } from "../document/editBasisKey";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { selectedClipIdsOf } from "../state/selection";
import type { DawState } from "../state/types";
import {
  allClipsFromTracks,
  type ClipMoveItem,
  computeClipMoves,
} from "./clipMove";

type Capture = {
  token: number;
  projectPath: string;
  projectEpoch: number;
  basis: NonNullable<DawState["project"]>;
  key: string;
  selection: string;
  anchorId: string;
  movingIds: string[];
  trackIds: string[];
};
type Placement = {
  capture: Capture;
  start: string;
  trackId: string;
  placements: ClipMoveItem[];
  error: string | null;
};
export type ClipPlacement =
  | { kind: "idle" }
  | ({ kind: "preview" | "committing" } & Placement);

const IDLE: ClipPlacement = { kind: "idle" };
let current: ClipPlacement = IDLE;
let nextToken = 0;
const listeners = new Set<() => void>();
const publish = (next: ClipPlacement) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useClipPlacement = () =>
  useSyncExternalStore(subscribe, () => current);
export const getClipPlacement = () => current;

function selectionKey(s: DawState): string {
  return JSON.stringify([
    s.selection?.kind,
    s.selection?.kind === "clip" ? s.selection.id : null,
    selectedClipIdsOf(s.selection),
  ]);
}
export function canPlaceClips(s: DawState): boolean {
  return (
    canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) &&
    !s.joinMutationInFlight &&
    s.heldTrim === null &&
    !s.timelineDragging
  );
}
function identityIsCurrent(capture: Capture, s: DawState): boolean {
  return (
    capture.projectPath === s.projectPath &&
    capture.projectEpoch === s.projectEpoch &&
    capture.selection === selectionKey(s) &&
    canPlaceClips(s)
  );
}
export function clipPlacementIsCurrent(token: number): boolean {
  const s = useDawStore.getState();
  return (
    current.kind !== "idle" &&
    current.capture.token === token &&
    identityIsCurrent(current.capture, s) &&
    current.capture.key === editBasisKey(s.projectEditBasis())
  );
}
export function cancelClipPlacement(token?: number): void {
  if (
    current.kind !== "idle" &&
    (token === undefined || current.capture.token === token)
  )
    publish(IDLE);
}
export function beginClipPlacement(anchorId: string): number | null {
  const s = useDawStore.getState();
  const basis = s.projectEditBasis();
  if (!basis || !canPlaceClips(s) || current.kind === "committing") return null;
  const anchor = allClipsFromTracks(basis.clips.tracks).find(
    (clip) => clip.id === anchorId,
  );
  if (!anchor) return null;
  const capture: Capture = {
    token: ++nextToken,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    basis,
    key: editBasisKey(basis),
    selection: selectionKey(s),
    anchorId,
    movingIds: selectedClipIdsOf(s.selection).includes(anchorId)
      ? [...selectedClipIdsOf(s.selection)]
      : [anchorId],
    trackIds: basis.tracks.map((track) => track.id),
  };
  publish({
    kind: "preview",
    capture,
    start: String(anchor.timeline_start),
    trackId: anchor.track_id,
    placements: [],
    error: null,
  });
  updateClipPlacement(
    capture.token,
    String(anchor.timeline_start),
    anchor.track_id,
  );
  return capture.token;
}
export function updateClipPlacement(
  token: number,
  start: string,
  trackId: string,
): void {
  if (current.kind !== "preview" || current.capture.token !== token) return;
  if (!clipPlacementIsCurrent(token)) {
    cancelClipPlacement(token);
    return;
  }
  const capture = current.capture;
  const clips = allClipsFromTracks(capture.basis.clips.tracks);
  const anchor = clips.find((clip) => clip.id === capture.anchorId);
  const value = Number(start);
  const valid =
    start.trim() !== "" &&
    Number.isFinite(value) &&
    value >= 0 &&
    capture.trackIds.includes(trackId);
  const placements =
    valid && anchor
      ? computeClipMoves({
          clips,
          trackIds: capture.trackIds,
          movingIds: capture.movingIds,
          anchorId: capture.anchorId,
          destTrackId: trackId,
          deltaSec: value - anchor.timeline_start,
        })
      : [];
  publish({
    kind: "preview",
    capture,
    start,
    trackId,
    placements,
    error: valid
      ? null
      : "Enter a timeline start of zero or more seconds and choose a track.",
  });
}
export async function applyClipPlacement(token: number): Promise<void> {
  if (
    current.kind !== "preview" ||
    current.capture.token !== token ||
    current.placements.length === 0
  )
    return;
  if (!clipPlacementIsCurrent(token)) {
    cancelClipPlacement(token);
    return;
  }
  const active = current;
  const clips = allClipsFromTracks(active.capture.basis.clips.tracks);
  const changed = active.placements.some((move) => {
    const clip = clips.find((row) => row.id === move.clip_id);
    return (
      clip?.timeline_start !== move.timeline_start ||
      clip.track_id !== move.track_id
    );
  });
  if (!changed) {
    cancelClipPlacement(token);
    return;
  }
  publish({ ...active, kind: "committing", error: null });
  try {
    const result = await executePointerCommand("edit.moveClips", {
      clips: active.placements,
      placementToken: token,
    });
    const settled = getClipPlacement();
    if (settled.kind === "idle" || settled.capture.token !== token) return;
    if (result.status === "ok") cancelClipPlacement(token);
    else if (clipPlacementIsCurrent(token))
      publish({
        ...active,
        error:
          result.status === "disabled"
            ? result.reason
            : "Move unavailable. Cancel and reopen Move clip.",
      });
    else cancelClipPlacement(token);
  } catch (error) {
    if (clipPlacementIsCurrent(token))
      publish({
        ...active,
        error:
          error instanceof Error ? error.message : "Move failed. Try again.",
      });
    else cancelClipPlacement(token);
  }
}

useDawStore.subscribe((s) => {
  if (current.kind === "idle") return;
  const { capture } = current;
  if (
    !identityIsCurrent(capture, s) ||
    (current.kind === "preview" &&
      capture.key !== editBasisKey(s.projectEditBasis()))
  )
    cancelClipPlacement(capture.token);
});
