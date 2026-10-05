import { useEffect, useRef, useState } from "react";
import {
  canPlayPendingPreview,
  pendingPreviewBlockReason,
  playPendingPreview,
  releasePendingPreview,
} from "../audio/pendingPreview";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { InspectorSeekFooterView } from "../ui/InspectorSeekFooterView";
import type { PreviewMode } from "../utils/playRange";

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
      onSeek={() => useDawStore.getState().setPlayheadSec(seekSec)}
      onPlay={() => void play()}
      previewMode={mode}
      onPreviewModeChange={onModeChange}
      playDisabled={busy || blocked !== null}
      playDisabledReason={
        busy ? "Preparing full mix preview" : (blocked ?? undefined)
      }
      suggestDisabled={edit.suggest_reason !== null}
      suggestDisabledReason={edit.suggest_reason}
    />
  );
}
