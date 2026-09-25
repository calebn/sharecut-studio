import type { ClipMuteRegion, ClipRow, ProjectView } from "../types/project";

function sameMuteRegions(
  a: ClipMuteRegion[] | undefined,
  b: ClipMuteRegion[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every(
    (r, i) => r.start_s === b[i]!.start_s && r.end_s === b[i]!.end_s,
  );
}

/**
 * Same own keys with equal values; `mute_regions` compared per region.
 * Any other nested value compares by identity, so a freshly parsed one never
 * matches. That is safe (the row only loses reuse), but a nested field added to
 * `ClipRow` or `TrackView` that should keep reuse needs its own case here.
 */
function sameShallow<T extends object>(a: T, b: T): boolean {
  const aKeys = Object.keys(a) as (keyof T)[];
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => {
    if (!Object.hasOwn(b, key)) {
      return false;
    }
    if (key === "mute_regions") {
      return sameMuteRegions(
        a[key] as ClipMuteRegion[] | undefined,
        b[key] as ClipMuteRegion[] | undefined,
      );
    }
    return a[key] === b[key];
  });
}

/** Same `clips` fields other than the lanes (count, duration, any later key). */
function sameClipsMeta(
  a: ProjectView["clips"],
  b: ProjectView["clips"],
): boolean {
  return sameShallow({ ...a, tracks: null }, { ...b, tracks: null });
}

/**
 * `next` items replaced by the equal `prev` item with the same id; the
 * whole `prev` array when every item was reused in the same order.
 */
function reuseById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev === next) {
    return prev;
  }
  const byId = new Map(prev.map((item) => [item.id, item]));
  let allReused = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byId.get(item.id);
    if (old && sameShallow(old, item)) {
      if (prev[i] !== old) {
        allReused = false;
      }
      return old;
    }
    allReused = false;
    return item;
  });
  return allReused ? prev : out;
}

/**
 * Structural sharing for a new project projection: tracks and clips equal to
 * the previous ones keep their identity (and so do whole lanes), so memoized
 * timeline rows re-render only for what changed.
 */
export function reuseUnchanged(
  prev: ProjectView | null,
  next: ProjectView,
): ProjectView {
  if (!prev || prev === next) {
    return next;
  }
  const tracks = reuseById(prev.tracks, next.tracks);
  const prevLanes = prev.clips.tracks;
  const nextLanes = next.clips.tracks;
  let lanes = nextLanes;
  if (prevLanes !== nextLanes) {
    const reused: Record<string, ClipRow[]> = {};
    let allLanesReused =
      Object.keys(prevLanes).length === Object.keys(nextLanes).length;
    for (const [trackId, clips] of Object.entries(nextLanes)) {
      const old = prevLanes[trackId];
      const lane = old ? reuseById(old, clips) : clips;
      if (lane !== old) {
        allLanesReused = false;
      }
      reused[trackId] = lane;
    }
    lanes = allLanesReused ? prevLanes : reused;
  }
  const clips =
    lanes === prevLanes && sameClipsMeta(prev.clips, next.clips)
      ? prev.clips
      : lanes === nextLanes
        ? next.clips
        : { ...next.clips, tracks: lanes };
  if (tracks === next.tracks && clips === next.clips) {
    return next;
  }
  return { ...next, tracks, clips };
}
