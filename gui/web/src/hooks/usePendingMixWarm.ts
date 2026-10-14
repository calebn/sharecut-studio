import { useEffect } from "react";
import { warmPendingPreview } from "../audio/pendingPreview";
import { useDawStore } from "../state/dawStore";
import { isPipelineSlotBusy } from "../utils/pipeline";

/** Quiet time after the last mix change before the host measures it. */
export const PENDING_MIX_WARM_DEBOUNCE_MS = 3000;
/** A host that was busy or refused is asked again after this, a few times. */
export const PENDING_MIX_WARM_RETRY_MS = 30_000;
const PENDING_MIX_WARM_ATTEMPTS = 3;

/**
 * Has the host measure the mix in the background as soon as a project with pending
 * edits is open, and again once its mix changes and settles, so the first Play
 * around on an edit is a cached file instead of the whole-episode passes
 * (#1551). Host only; nothing runs for a project with no edit awaiting review,
 * while a render or pipeline job is busy, or for a guest.
 */
export function usePendingMixWarm(enabled: boolean): void {
  const projectPath = useDawStore((s) => s.projectPath);
  const hasPending = useDawStore(
    (s) => s.project?.pending_edits.some((e) => e.review_required) ?? false,
  );
  const tracks = useDawStore((s) => s.project?.tracks);
  const clips = useDawStore((s) => s.project?.clips);
  const effects = useDawStore((s) => s.project?.effects_by_track);
  const envelopes = useDawStore((s) => s.project?.envelopes);
  const busy = useDawStore(
    (s) =>
      s.renderPreviewBusy ||
      isPipelineSlotBusy(s.pipelineJob) ||
      isPipelineSlotBusy(s.activityJob),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the mix inputs are the triggers
  useEffect(() => {
    if (!enabled || !hasPending || busy || !projectPath) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (left: number, delay: number) => {
      timer = setTimeout(async () => {
        const done = await warmPendingPreview(projectPath, null);
        if (!done && !cancelled && left > 1) {
          attempt(left - 1, PENDING_MIX_WARM_RETRY_MS);
        }
      }, delay);
    };
    attempt(PENDING_MIX_WARM_ATTEMPTS, PENDING_MIX_WARM_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    enabled,
    hasPending,
    busy,
    projectPath,
    tracks,
    clips,
    effects,
    envelopes,
  ]);
}
