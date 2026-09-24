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

/** Backoff schedule while the server is still generating an overview. */
export const PEAKS_RETRY_BASE_MS = 1000;
export const PEAKS_RETRY_MAX_MS = 10000;
export const PEAKS_MAX_RETRIES = 30;

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
const listeners = new Set<() => void>();

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

/** Clear the cached ready peaks and wake mounted hooks so they refetch.
 *
 * Pass `projectPath` and `trackId` to invalidate one track, `projectPath`
 * alone to invalidate every track in a project, or nothing to clear all. */
export function invalidatePeaks(projectPath?: string, trackId?: string): void {
  if (projectPath && trackId) {
    cache.delete(cacheKey(projectPath, trackId));
  } else if (projectPath) {
    const prefix = `${projectPath}::`;
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
  for (const listener of listeners) {
    listener();
  }
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
 * While the server reports it is still generating an overview, this polls with
 * capped backoff up to `PEAKS_MAX_RETRIES` before settling on "unavailable".
 * Call `invalidatePeaks()` to force every mounted hook to refetch. */
export function usePeaks(
  projectPath: string,
  trackId: string,
  enabled: boolean,
  version = "",
): PeaksState {
  const [nonce, setNonce] = useState(0);
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
    const listener = () => setNonce((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

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
        if (result.status === "generating" && retry < PEAKS_MAX_RETRIES) {
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
    // `nonce` has no value of its own; it only re-runs this effect on invalidatePeaks().
  }, [projectPath, trackId, enabled, version, nonce]);

  return state;
}
