import { useRef } from "react";
import type { AppliedEditRecord, AutomationEnvelope } from "../types/project";

/** A track-keyed slice of `items`, one array per track it appears on. */
export type TrackSlices<T> = Readonly<Record<string, readonly T[]>>;

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Groups `items` by every track id `trackIdsOf` returns for them. A track
 * whose resulting list is identical (same items, same order) to its `prev`
 * entry keeps that array's identity, so a memoized per-lane component (e.g.
 * `TrackLane`) bails out for lanes nothing changed on, even when other lanes
 * did.
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
    next[trackId] = prevList && sameItems(prevList, list) ? prevList : list;
  }
  return next;
}

/**
 * `groupByTrack`, memoized across renders: reuses the previous per-track
 * arrays where nothing changed, and does no work at all when `items` itself
 * kept its identity (structural sharing from `reuseUnchanged`).
 */
export function useByTrack<T>(
  items: readonly T[],
  trackIdsOf: (item: T) => readonly string[],
): TrackSlices<T> {
  const itemsRef = useRef<readonly T[] | null>(null);
  const slicesRef = useRef<TrackSlices<T>>({});
  if (itemsRef.current !== items) {
    itemsRef.current = items;
    slicesRef.current = groupByTrack(items, trackIdsOf, slicesRef.current);
  }
  return slicesRef.current;
}

export function envelopeTrackIds(e: AutomationEnvelope): readonly string[] {
  return [e.track_id];
}

export function appliedRecordTrackIds(r: AppliedEditRecord): readonly string[] {
  return r.track_ids;
}
