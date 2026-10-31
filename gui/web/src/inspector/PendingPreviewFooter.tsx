import { useEffect, useRef, useState } from "react";
import {
  canPlayPendingPreview,
  pendingPreviewBlockReason,
  playPendingPreview,
  releasePendingPreview,
  warmPendingPreview,
} from "../audio/pendingPreview";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { PendingEditView } from "../types/project";
import { InspectorSeekFooterView } from "../ui/InspectorSeekFooterView";
import type { PreviewMode } from "../utils/playRange";

/** A click that returns sooner never shows the busy label (docs/communication-philosophy.md). */
const BUSY_LABEL_AFTER_SEC = 2;

/** Whole seconds since `active` turned true; null while it is false. */
function useElapsedSec(active: boolean): number | null {
  const [sec, setSec] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setSec(null);
      return;
    }
    const started = Date.now();
    setSec(0);
    const timer = setInterval(
      () => setSec(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);
  return sec;
}

/** Seek plus the server-rendered Current / Suggested / A/B listen for one pending edit. */
export function PendingPreviewFooter({
  edit,
  projectPath,
  seekSec,
  mode,
  onModeChange,
  onError,
}: {
  edit: PendingEditView;
  projectPath: string;
  seekSec: number;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const canPlay = useDawStore((state) =>
    canPlayPendingPreview(state, projectPath),
  );
  useEffect(() => () => releasePendingPreview(edit.id), [edit.id]);
  const { tracks, clips, effects, envelopes } = useDaw((state) => ({
    tracks: state.project?.tracks,
    clips: state.project?.clips,
    effects: state.project?.effects_by_track,
    envelopes: state.project?.envelopes,
  }));
  // Warm again once a fader, mute, effect or edit has settled: the cached renders
  // and the mix headroom belong to the mix they were made from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mix inputs are the triggers
  useEffect(() => {
    if (!canPlay) return;
    const timer = setTimeout(
      () => void warmPendingPreview(projectPath, edit.id),
      1500,
    );
    return () => clearTimeout(timer);
  }, [canPlay, projectPath, edit.id, tracks, clips, effects, envelopes]);
  const busySec = useElapsedSec(busy);
  const blocked = pendingPreviewBlockReason(edit, mode, canPlay);
  const play = async () => {
    const request = ++latest.current;
    setBusy(true);
    onError(null);
    const outcome = await playPendingPreview(projectPath, edit.id, mode);
    if (request !== latest.current) return;
    setBusy(false);
    if (outcome.status === "disabled") onError(outcome.reason);
  };
  return (
    <InspectorSeekFooterView
      onSeek={() => void seekTransport(seekSec)}
      onPlay={() => void play()}
      playBusySec={
        busySec !== null && busySec >= BUSY_LABEL_AFTER_SEC ? busySec : null
      }
      previewMode={mode}
      onPreviewModeChange={onModeChange}
      playPreparing={busy}
      playDisabledReason={blocked ?? undefined}
      suggestDisabledReason={edit.suggest_reason}
    />
  );
}
