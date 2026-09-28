import type {
  AppliedEditRecord,
  AutomationEnvelope,
  AutomationPoint,
  ClipMuteRegion,
  ClippingRegion,
  ClipRow,
  PendingEditView,
  ProjectView,
} from "../types/project";
import { jsonEqual } from "../utils/jsonEqual";

type SourceSpans = ClipMuteRegion[] | ClippingRegion[];

/** Same length and pairwise-equal items (`eq`, default `Object.is`). */
export function sameItems<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = Object.is,
): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => eq(x, b[i]!)));
}

function sameSourceSpans(
  a: SourceSpans | undefined,
  b: SourceSpans | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return sameItems<{ start_s: number; end_s: number }>(
    a,
    b,
    (r, s) => r.start_s === s.start_s && r.end_s === s.end_s,
  );
}

/**
 * Same own keys with equal values; `mute_regions` and `clipping_regions`
 * compared per region, and any key named in `deepKeys` compared structurally
 * (`jsonEqual`) instead of by identity.
 * Any other nested value compares by identity, so a freshly parsed one never
 * matches. That is safe (the row only loses reuse), but a nested field added
 * that should keep reuse needs its own case here or a `deepKeys` entry.
 */
function sameExcept<T extends object>(
  a: T,
  b: T,
  deepKeys: readonly (keyof T)[] = [],
): boolean {
  const aKeys = Object.keys(a) as (keyof T)[];
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => {
    if (!Object.hasOwn(b, key)) {
      return false;
    }
    if (key === "mute_regions" || key === "clipping_regions") {
      return sameSourceSpans(
        a[key] as SourceSpans | undefined,
        b[key] as SourceSpans | undefined,
      );
    }
    if (deepKeys.includes(key)) {
      return jsonEqual(a[key], b[key]);
    }
    return a[key] === b[key];
  });
}

function sameShallow<T extends object>(a: T, b: T): boolean {
  return sameExcept(a, b);
}

/** Same `clips` fields other than the lanes (count, duration, any later key). */
function sameClipsMeta(
  a: ProjectView["clips"],
  b: ProjectView["clips"],
): boolean {
  return sameShallow({ ...a, tracks: null }, { ...b, tracks: null });
}

/**
 * Envelopes have no `id`; keyed by the pair that identifies one on a track.
 * The domain keeps at most one envelope per (`track_id`, `parameter`). If two
 * ever shared a key, `reuseByKey`'s map keeps the last, so the earlier one
 * only loses reuse; the result still holds every `next` envelope (pinned in
 * `reuseUnchanged.test.ts`).
 */
export function envelopeKey(e: AutomationEnvelope): string {
  return `${e.track_id}\u0000${e.parameter}`;
}

export function idKey<T extends { id: string }>(item: T): string {
  return item.id;
}

/**
 * Same points in the same order, each with the same own keys and values.
 * Field by field (key-order-insensitive, nothing serialized), since a long
 * envelope is compared on every snapshot or patch.
 */
function samePoints(
  a: readonly AutomationPoint[],
  b: readonly AutomationPoint[],
): boolean {
  return sameItems(a, b, sameShallow);
}

function sameEnvelope(a: AutomationEnvelope, b: AutomationEnvelope): boolean {
  return (
    a.track_id === b.track_id &&
    a.parameter === b.parameter &&
    samePoints(a.points, b.points)
  );
}

function samePendingEdit(a: PendingEditView, b: PendingEditView): boolean {
  return sameExcept(a, b, ["timeline_spans", "track_ids"]);
}

function sameAppliedRecord(
  a: AppliedEditRecord,
  b: AppliedEditRecord,
): boolean {
  return sameExcept(a, b, ["params", "track_ids"]);
}

/**
 * `next` items replaced by the equal `prev` item with the same key; the
 * whole `prev` array when every item was reused in the same order.
 */
export function reuseByKey<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string,
  same: (a: T, b: T) => boolean,
): T[] {
  if (prev === next) {
    return prev;
  }
  const byKey = new Map(prev.map((item) => [keyOf(item), item]));
  let allReused = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byKey.get(keyOf(item));
    if (old && same(old, item)) {
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

/** `reuseByKey` keyed by `id`, comparing items with `sameShallow`. */
function reuseById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  return reuseByKey(prev, next, idKey, sameShallow);
}

/**
 * Structural sharing for a new project projection: tracks, clips, envelopes,
 * pending edits and applied-edit records equal to the previous ones keep
 * their identity (and so do whole lanes), so memoized timeline rows re-render
 * only for what changed.
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

  const envelopes = reuseByKey(
    prev.envelopes,
    next.envelopes,
    envelopeKey,
    sameEnvelope,
  );

  const pendingEdits = reuseByKey(
    prev.pending_edits,
    next.pending_edits,
    idKey,
    samePendingEdit,
  );

  const prevApplied = prev.applied_edits;
  const nextApplied = next.applied_edits;
  let appliedEdits = nextApplied;
  if (prevApplied !== nextApplied) {
    const records = reuseByKey(
      prevApplied.records,
      nextApplied.records,
      idKey,
      sameAppliedRecord,
    );
    appliedEdits =
      records === prevApplied.records &&
      sameShallow(
        { ...prevApplied, records: null },
        { ...nextApplied, records: null },
      )
        ? prevApplied
        : records === nextApplied.records
          ? nextApplied
          : { ...nextApplied, records };
  }

  if (
    tracks === next.tracks &&
    clips === next.clips &&
    envelopes === next.envelopes &&
    pendingEdits === next.pending_edits &&
    appliedEdits === next.applied_edits
  ) {
    return next;
  }
  return {
    ...next,
    tracks,
    clips,
    envelopes,
    pending_edits: pendingEdits,
    applied_edits: appliedEdits,
  };
}
