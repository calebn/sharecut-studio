import { useEffect } from "react";
import {
  canPlayPendingPreview,
  releasePendingPreview,
  warmPendingPreview,
} from "../../audio/pendingPreview";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";

/** Quiet time after the last mix change before the preview renders are warmed. */
const WARM_DEBOUNCE_MS = 1500;

/**
 * Keeps one pending edit's Hear before and Hear after previews ready while its sheet is open:
 * warms the server renders once a fader, mute, effect or edit has settled (the cached renders and
 * the mix headroom belong to the mix they were made from), and stops the audio the edit owns when
 * the sheet closes or shows another edit. The Action bar plays; this only prepares and releases.
 * Warms only where the share may play audio.
 */
export function usePendingEditWarm(
  projectPath: string,
  editId: string,
  enabled: boolean,
): void {
  const canPlay = useDawStore((state) =>
    canPlayPendingPreview(state, projectPath),
  );
  const { tracks, clips, effects, envelopes } = useDaw((state) => ({
    tracks: state.project?.tracks,
    clips: state.project?.clips,
    effects: state.project?.effects_by_track,
    envelopes: state.project?.envelopes,
  }));
  useEffect(() => {
    if (!enabled) return;
    return () => releasePendingPreview(editId);
  }, [enabled, editId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mix inputs are the triggers
  useEffect(() => {
    if (!enabled || !canPlay) return;
    const timer = setTimeout(
      () => void warmPendingPreview(projectPath, editId),
      WARM_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [
    enabled,
    canPlay,
    projectPath,
    editId,
    tracks,
    clips,
    effects,
    envelopes,
  ]);
}
