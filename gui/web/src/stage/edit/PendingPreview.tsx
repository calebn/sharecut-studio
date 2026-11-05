import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  canPlayPendingPreview,
  pendingPreviewBlockReason,
  playPendingPreview,
} from "../../audio/pendingPreview";
import { seekTransport } from "../../commands/seek";
import { createActiveElapsedSample } from "../../hooks/sampledClocks";
import { useDawStore } from "../../state/dawStore";
import type { PendingEditView } from "../../types/project";
import { InspectorSeekFooterView } from "../../ui/InspectorSeekFooterView";
import type { PreviewMode } from "../../utils/playRange";

const BUSY_LABEL_AFTER_SEC = 2;

function useElapsedSec(active: boolean): number | null {
  const [clock] = useState(createActiveElapsedSample);
  const sec = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  useEffect(() => clock.connect(active), [clock, active]);
  return sec;
}

/**
 * Seek plus the server-rendered Current / Suggested / A/B listen for one pending edit, for a sheet
 * with no Action bar (the bar's Hear, A/B and Seek replace it). Warming and releasing the
 * previews is `usePendingEditWarm`'s, not this footer's.
 */
export function PendingPreview({
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
