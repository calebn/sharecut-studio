import { useEffect } from "react";
import { reviewVersionAtBootstrap } from "../api";
import { loadReviewPeaks } from "../api/reviewPeaks";
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

  useEffect(() => {
    const { setReviewPeaks } = useDawStore.getState();
    if (!token || !versionId || !canPlay) {
      setReviewPeaks([]);
      return;
    }
    let current = true;
    void loadReviewPeaks(token, versionId).then((peaks) => {
      if (current) setReviewPeaks(peaks);
    });
    return () => {
      current = false;
    };
  }, [token, versionId, canPlay]);
}
