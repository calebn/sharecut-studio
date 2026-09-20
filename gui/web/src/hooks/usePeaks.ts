import { useEffect, useState } from "react";
import { loadPeaks } from "../api";
import type { PeaksData } from "../types/project";
import { coercePeaksPayload } from "../utils/peaks";

const cache = new Map<string, PeaksData | null>();
const inflight = new Map<string, Promise<PeaksData | null>>();

function cacheKey(projectPath: string, trackId: string): string {
  return `${projectPath}::${trackId}`;
}

async function fetchPeaksCached(
  projectPath: string,
  trackId: string,
): Promise<PeaksData | null> {
  const key = cacheKey(projectPath, trackId);
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadPeaks(projectPath, trackId).then((data) => {
      const coerced = data ? coercePeaksPayload(data) : null;
      cache.set(key, coerced);
      inflight.delete(key);
      return coerced;
    });
    inflight.set(key, pending);
  }
  return pending;
}

/** Track-level peaks cache — one fetch per (project, track), shared by clips. */
export function usePeaks(
  projectPath: string,
  trackId: string,
  enabled: boolean,
): PeaksData | null {
  const [peaks, setPeaks] = useState<PeaksData | null>(() => {
    if (!enabled) {
      return null;
    }
    return cache.get(cacheKey(projectPath, trackId)) ?? null;
  });

  useEffect(() => {
    if (!enabled || !projectPath || !trackId) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    void fetchPeaksCached(projectPath, trackId).then((data) => {
      if (!cancelled) {
        setPeaks(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, trackId, enabled]);

  return peaks;
}
