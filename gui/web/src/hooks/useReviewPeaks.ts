import { useEffect } from "react";
import { loadReviewPeaks, reviewVersionAtBootstrap } from "../api";
import { shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ReviewVersion } from "./useReviewVersion";

/**
 * Keeps `reviewPeaks` in the store for the version a review link plays: loaded
 * once the page has bootstrapped and again when a following link changes
 * version. Does nothing for a host or a link that may not play.
 */
export function useReviewPeaks(version: ReviewVersion | null): void {
  const { projectPath, canPlay } = useDaw((s) => ({
    projectPath: s.projectPath,
    canPlay: s.shareCapabilities?.includes("play") ?? false,
  }));
  const token = shareTokenFromKey(projectPath);
  const versionId =
    version?.versionId ?? (token ? reviewVersionAtBootstrap(token) : null);

  // The strip never shows another version's or another share's columns.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger
  useEffect(() => {
    useDawStore.getState().setReviewPeaks([]);
  }, [token, versionId]);

  // Re-runs with each version poll (`version` is a fresh object per read), so an
  // empty answer is asked again on the next poll, not in a loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` only re-triggers the retry
  useEffect(() => {
    const { setReviewPeaks } = useDawStore.getState();
    if (!token || !versionId || !canPlay) {
      setReviewPeaks([]);
      return;
    }
    let current = true;
    void loadReviewPeaks(token, versionId).then((peaks) => {
      if (current && peaks.length > 0) setReviewPeaks(peaks);
    });
    return () => {
      current = false;
    };
  }, [token, versionId, canPlay, version]);
}
