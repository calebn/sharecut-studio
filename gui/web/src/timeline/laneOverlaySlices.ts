import { useLayoutEffect, useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import type { AppliedEditRecord, AutomationEnvelope } from "../types/project";

/** A track-keyed slice of `items`, one array per track it appears on. */
export type TrackSlices<T> = Readonly<Record<string, readonly T[]>>;

/**
 * Groups `items` by every track id `trackIdsOf` returns for them. A track
 * whose resulting list is identical (same items, same order) to its `prev`
 * entry keeps that array's identity, so a memoized per-lane component (e.g.
 * `TrackLane`) bails out for lanes nothing changed on, even when other lanes
 * did.
 *
 * Cost: O(items x track ids per item), run only when the project-wide array
 * changes identity (`useByTrack`). Negligible at tens of tracks and hundreds
 * of records; revisit (e.g. patch-driven per-track updates) if either grows
 * by orders of magnitude.
 */
export function groupByTrack<T>(
  items: readonly T[],
  trackIdsOf: (item: T) => readonly string[],
  prev?: TrackSlices<T>,
): TrackSlices<T> {
  const building: Record<string, T[]> = {};
  for (const item of items) {
    for (const trackId of trackIdsOf(item)) {
      (building[trackId] ??= []).push(item);
    }
  }
  if (!prev) {
    return building;
  }
  const next: Record<string, readonly T[]> = {};
  for (const [trackId, list] of Object.entries(building)) {
    const prevList = prev[trackId];
    next[trackId] = prevList && shallow(prevList, list) ? prevList : list;
  }
  return next;
}

/**
 * `groupByTrack`, memoized across renders: reuses the previous per-track
 * arrays where nothing changed, and does no work at all when `items` itself
 * kept its identity (structural sharing from `reuseUnchanged`). The reuse
 * baseline is the last *committed* result (advanced in a layout effect), so
 * a render React discards never moves it.
 */
export function useByTrack<T>(
  items: readonly T[],
  trackIdsOf: (item: T) => readonly string[],
): TrackSlices<T> {
  const committedRef = useRef<TrackSlices<T>>({});
  const slices = useMemo(
    () => groupByTrack(items, trackIdsOf, committedRef.current),
    [items, trackIdsOf],
  );
  useLayoutEffect(() => {
    committedRef.current = slices;
  }, [slices]);
  return slices;
}

export function envelopeTrackIds(e: AutomationEnvelope): readonly string[] {
  return [e.track_id];
}

export function appliedRecordTrackIds(r: AppliedEditRecord): readonly string[] {
  return r.track_ids;
}
