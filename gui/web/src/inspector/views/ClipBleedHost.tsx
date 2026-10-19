import { useEffect, useState, useSyncExternalStore } from "react";
import {
  clipBleedDisabledReason,
  undoClipBleed,
} from "../../commands/clipBleed";
import { executePointerCommand } from "../../commands/pointer";
import { clipBleedSession } from "../../edit/clipBleedSession";
import { useClipPlacement } from "../../edit/clipPlacement";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { BleedAttenuationInspector } from "./BleedAttenuationInspector";

export type ClipBleedHostProps = {
  trackId: string;
  clipId: string;
  clipLabel: string;
};

export function ClipBleedHost({
  trackId,
  clipId,
  clipLabel,
}: ClipBleedHostProps) {
  const state = useDaw((s) => ({
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    project: s.project,
    guestMode: s.guestMode,
    selection: s.selection,
    heldTrim: s.heldTrim,
    joinMutationInFlight: s.joinMutationInFlight,
    rangeBusy: s.rangeBusy,
    timelineDragging: s.timelineDragging,
  }));
  useClipPlacement();
  const snapshot = useSyncExternalStore(
    clipBleedSession.subscribe,
    clipBleedSession.getSnapshot,
  );
  const host =
    state.guestMode === null && !isShareProjectKey(state.projectPath);
  const occurrence = { trackId, clipId, clipLabel };
  const active =
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

  useEffect(() => {
    if (host) void clipBleedSession.open({ trackId, clipId, clipLabel });
    else clipBleedSession.retire();
    return () => clipBleedSession.retire();
  }, [host, state.projectPath, state.projectEpoch, trackId, clipId, clipLabel]);

  useEffect(() => {
    const selection = state.selection;
    if (
      !active ||
      active.action.state === "saving" ||
      active.action.state === "undoing" ||
      selection?.kind !== "bleedAttenuation" ||
      selection.id !== clipId ||
      selection.trackId !== trackId
    )
      return;
    if (active.read.state === "ready") {
      if (
        active.selectedKey !== selection.regionKey &&
        !clipBleedSession.select(selection.regionKey) &&
        selection.regionKey !== null
      )
        useDawStore.getState().setSelection({ ...selection, regionKey: null });
    } else if (active.read.state === "error" && selection.regionKey !== null) {
      useDawStore.getState().setSelection({ ...selection, regionKey: null });
    }
  }, [active, state.selection, clipId, trackId]);

  const reason = clipBleedDisabledReason();
  return (
    <BleedAttenuationInspector
      read={
        host
          ? (active?.read ?? {
              state: "error",
              message: "Refresh regions to inspect this clip.",
            })
          : {
              state: "error",
              message: "Only the project host can inspect this audio.",
            }
      }
      selectedKey={active?.selectedKey ?? null}
      onSelect={(key) => {
        const selection = useDawStore.getState().selection;
        if (
          selection?.kind === "bleedAttenuation" &&
          selection.id === clipId &&
          selection.trackId === trackId &&
          clipBleedSession.select(key)
        )
          useDawStore.getState().setSelection({ ...selection, regionKey: key });
      }}
      access={host ? "host" : "guest"}
      canRestore={reason === undefined}
      permissionReason={reason}
      action={
        action?.state === "saving" || action?.state === "undoing"
          ? {
              ...action,
              elapsedSeconds: elapsed.action === action ? elapsed.seconds : 0,
            }
          : (action ?? { state: "idle" })
      }
      onRestore={() => {
        const generation = active?.generation;
        void executePointerCommand("edit.restoreClipBleed").then((result) => {
          const current = clipBleedSession.getSnapshot();
          if (
            current?.generation === generation &&
            current?.occurrence.trackId === trackId &&
            current.occurrence.clipId === clipId &&
            result.status === "disabled" &&
            !result.announced &&
            current.action.state !== "error"
          )
            useDawStore.getState().announceStatus(result.reason);
        });
      }}
      onRefresh={() => {
        if (!host) return;
        if (active) void clipBleedSession.refresh();
        else void clipBleedSession.open(occurrence);
      }}
      undo={
        active?.undo
          ? {
              receipt: active.undo,
              onUndo: (receipt) => {
                void undoClipBleed(receipt);
              },
            }
          : undefined
      }
    />
  );
}
