import { useEffect, useState } from "react";
import { loadPeaks } from "../api";
import type { PeaksData, PeaksFetchResult } from "../types/project";
import { coercePeaksPayload } from "../utils/peaks";

export type PeaksStatus =
  | "idle"
  | "loading"
  | "generating"
  | "ready"
  | "unavailable";

export interface PeaksState {
  peaks: PeaksData | null;
  status: PeaksStatus;
}

/** Backoff schedule while the server is still generating an overview.
 * Polling continues at the capped interval for as long as the server answers
 * `generating: true`; only `generating: false` settles on "unavailable". */
export const PEAKS_RETRY_BASE_MS = 1000;
export const PEAKS_RETRY_MAX_MS = 10000;

export function peaksRetryDelayMs(attempt: number): number {
  return Math.min(PEAKS_RETRY_BASE_MS * 2 ** attempt, PEAKS_RETRY_MAX_MS);
}

interface ReadyEntry {
  version: string;
  peaks: PeaksData;
}

/** Ready results only, one entry per project::track (across versions). */
const cache = new Map<string, ReadyEntry>();
/** Dedupes concurrent fetches for the same project::track::version. */
const inflight = new Map<string, Promise<PeaksFetchResult>>();
function cacheKey(projectPath: string, trackId: string): string {
  return `${projectPath}::${trackId}`;
}

function inflightKey(
  projectPath: string,
  trackId: string,
  version: string,
): string {
  return `${projectPath}::${trackId}::${version}`;
}

function fetchOnce(
  projectPath: string,
  trackId: string,
  version: string,
): Promise<PeaksFetchResult> {
  const key = inflightKey(projectPath, trackId, version);
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadPeaks(projectPath, trackId).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  return pending;
}

function cachedReady(
  projectPath: string,
  trackId: string,
  version: string,
): PeaksState | null {
  const entry = cache.get(cacheKey(projectPath, trackId));
  if (entry && entry.version === version) {
    return { peaks: entry.peaks, status: "ready" };
  }
  return null;
}

/** Track-level peaks cache — one fetch per (project, track, version), shared by clips.
 *
 * While the server reports it is still generating an overview, this keeps
 * polling with capped backoff (`peaksRetryDelayMs`). It settles on
 * "unavailable" only when the server answers `generating: false`. A change to
 * `version` (media path / duration) refetches. */
export function usePeaks(
  projectPath: string,
  trackId: string,
  enabled: boolean,
  version = "",
): PeaksState {
  const [state, setState] = useState<PeaksState>(() => {
    if (!enabled) {
      return { peaks: null, status: "idle" };
    }
    return (
      cachedReady(projectPath, trackId, version) ?? {
        peaks: null,
        status: "loading",
      }
    );
  });

  useEffect(() => {
    if (!enabled || !projectPath || !trackId) {
      setState({ peaks: null, status: "idle" });
      return;
    }
    const ready = cachedReady(projectPath, trackId, version);
    if (ready) {
      setState(ready);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = (retry: number) => {
      void fetchOnce(projectPath, trackId, version).then((result) => {
        if (cancelled) {
          return;
        }
        if (result.status === "ready") {
          const coerced = coercePeaksPayload(result.peaks);
          cache.set(cacheKey(projectPath, trackId), {
            version,
            peaks: coerced,
          });
          setState({ peaks: coerced, status: "ready" });
          return;
        }
        if (result.status === "generating") {
          setState({ peaks: null, status: "generating" });
          timer = setTimeout(
            () => attempt(retry + 1),
            peaksRetryDelayMs(retry),
          );
          return;
        }
        setState({ peaks: null, status: "unavailable" });
      });
    };
    setState({ peaks: null, status: "loading" });
    attempt(0);

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [projectPath, trackId, enabled, version]);

  return state;
}
