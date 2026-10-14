import { useEffect, useRef } from "react";
import { runPointerCommand } from "../commands/pointer";
import { canRefreshMix } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { isPipelineSlotBusy } from "../utils/pipeline";
import { mixRebuildKey } from "../utils/staleRender";
import { autoMixPaused } from "./autoMixPref";
import { useStaleRenderBreakdown } from "./useStaleRenderBreakdown";

/** Quiet time after the last change before the mix rebuilds, so a burst of edits rebuilds once. */
export const AUTO_MIX_DEBOUNCE_MS = 1500;

/**
 * Rebuilds the mix on its own whenever a change leaves it behind (open with no
 * mix, an edit, a gain, mute or FX change, an alignment move), so the host
 * never has to click Refresh. The rebuild is the same single-flight
 * `render.refreshMix` the manual command runs; playback keeps using the live
 * per-track audio or the last good mix while it runs.
 *
 * A newer change waits for the running rebuild, then starts the next one. A
 * state the rebuild already tried and could not clear is not retried: only a
 * different change (a new key) or the manual command rebuilds again.
 */
export function useAutoRefreshMix(enabled: boolean): void {
  const project = useDawStore((s) => s.project);
  const projectPath = useDawStore((s) => s.projectPath);
  const guestMode = useDawStore((s) => s.guestMode);
  const shareCapabilities = useDawStore((s) => s.shareCapabilities);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const renderBusy = useDawStore((s) => s.renderPreviewBusy);
  const slotBusy = useDawStore(
    (s) =>
      isPipelineSlotBusy(s.pipelineJob) || isPipelineSlotBusy(s.activityJob),
  );
  const key = mixRebuildKey(useStaleRenderBreakdown(project));
  const attempted = useRef<{ epoch: number; key: string } | null>(null);
  const allowed =
    enabled && canRefreshMix(projectPath, guestMode, shareCapabilities);

  useEffect(() => {
    if (key == null) {
      // A fresh mix forgets the tried state: the same kind of change can come again.
      attempted.current = null;
      return;
    }
    if (!allowed || renderBusy || slotBusy || autoMixPaused()) {
      return;
    }
    const last = attempted.current;
    if (last && last.epoch === projectEpoch && last.key === key) {
      return;
    }
    const timer = window.setTimeout(() => {
      attempted.current = { epoch: projectEpoch, key };
      runPointerCommand("render.refreshMix", { auto: true });
    }, AUTO_MIX_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [allowed, key, renderBusy, slotBusy, projectEpoch]);
}
