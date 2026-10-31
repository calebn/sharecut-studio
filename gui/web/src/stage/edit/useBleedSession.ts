import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ClipBleedSnapshot,
  clipBleedSession,
} from "../../edit/clipBleedSession";
import { useClipPlacement } from "../../edit/clipPlacement";
import { rangeClips } from "../../edit/rangeSelection";
import { isGuestSession } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { Selection } from "../../types/project";

export type BleedTarget = Extract<
  NonNullable<Selection>,
  { kind: "bleedAttenuation" }
>;

const noSubscription = () => () => {};

/**
 * Opens and retires the shared clipBleedSession for one bleed selection, so the
 * Timeline overlay and the Inspector sheet read the same inspection (#2294).
 * Every subscription is off for any other selection.
 */
export function useBleedSession(bleed: BleedTarget | null) {
  const on = bleed != null;
  const state = useDaw((s) =>
    on
      ? {
          projectPath: s.projectPath,
          projectEpoch: s.projectEpoch,
          project: s.project,
          guestMode: s.guestMode,
          selection: s.selection,
          heldTrim: s.heldTrim,
          joinMutationInFlight: s.joinMutationInFlight,
          rangeBusy: s.rangeBusy,
          timelineDragging: s.timelineDragging,
        }
      : null,
  );
  useClipPlacement(on);
  const snapshot = useSyncExternalStore(
    on ? clipBleedSession.subscribe : noSubscription,
    clipBleedSession.getSnapshot,
  );
  const trackId = bleed?.trackId ?? "";
  const clipId = bleed?.id ?? "";
  const found =
    state?.project != null &&
    rangeClips(state.project).some(
      (row) => row.id === clipId && row.track_id === trackId,
    );
  const clipLabel =
    state?.project?.tracks.find((track) => track.id === trackId)?.label ??
    trackId;
  const host =
    state != null && !isGuestSession(state.projectPath, state.guestMode);
  const active: ClipBleedSnapshot =
    found &&
    snapshot?.occurrence.trackId === trackId &&
    snapshot.occurrence.clipId === clipId
      ? snapshot
      : null;
  const action = active?.action;
  const [elapsed, setElapsed] = useState<{
    action: typeof action;
    seconds: number;
  }>({ action: undefined, seconds: 0 });

  useEffect(() => {
    if (action?.state !== "saving" && action?.state !== "undoing") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed({
        action,
        seconds: Math.floor((Date.now() - started) / 1000),
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [action]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project or epoch reopens the same occurrence
  useEffect(() => {
    if (!found) return;
    if (host) void clipBleedSession.open({ trackId, clipId, clipLabel });
    else clipBleedSession.retire();
    return () => clipBleedSession.retire();
  }, [
    found,
    host,
    state?.projectPath,
    state?.projectEpoch,
    trackId,
    clipId,
    clipLabel,
  ]);

  const current = state?.selection;
  useEffect(() => {
    if (
      !active ||
      active.action.state === "saving" ||
      active.action.state === "undoing" ||
      current?.kind !== "bleedAttenuation" ||
      current.id !== clipId ||
      current.trackId !== trackId
    )
      return;
    if (active.read.state === "ready") {
      if (
        active.selectedKey !== current.regionKey &&
        !clipBleedSession.select(current.regionKey) &&
        current.regionKey !== null
      )
        useDawStore.getState().setSelection({ ...current, regionKey: null });
    } else if (active.read.state === "error" && current.regionKey !== null) {
      useDawStore.getState().setSelection({ ...current, regionKey: null });
    }
  }, [active, current, clipId, trackId]);

  const isThisClip = (selection: Selection): selection is BleedTarget =>
    selection?.kind === "bleedAttenuation" &&
    selection.id === clipId &&
    selection.trackId === trackId;

  return {
    found,
    host,
    active,
    clipLabel,
    trackId,
    clipId,
    isThisClip,
    elapsedSeconds: elapsed.action === action ? elapsed.seconds : 0,
  };
}
