import type { ProjectView, Selection } from "../types/project";

type Chosen = NonNullable<Selection>;

const NONE: readonly string[] = Object.freeze([]);
const clipSets = new WeakMap<object, readonly string[]>();
const trackSets = new WeakMap<object, readonly string[]>();

function cached(
  cache: WeakMap<object, readonly string[]>,
  selection: Chosen,
  ids: readonly string[],
): readonly string[] {
  const hit = cache.get(selection);
  if (hit) return hit;
  cache.set(selection, ids);
  return ids;
}

/**
 * The clips `selection` holds: the primary clip and any added with Shift or
 * Mod. A view over the selection, stable for as long as the selection is.
 */
export function selectedClipIdsOf(selection: Selection): readonly string[] {
  if (selection?.kind !== "clip") return NONE;
  return cached(clipSets, selection, selection.ids ?? [selection.id]);
}

/**
 * The tracks `selection` scopes: a track selection's set, or the tracks of a
 * range. Every other kind scopes none, and track-scoped commands read that as
 * every dialogue track.
 */
export function selectedTrackIdsOf(selection: Selection): readonly string[] {
  if (selection?.kind === "track") {
    return cached(
      trackSets,
      selection,
      selection.trackIds ?? [selection.trackId],
    );
  }
  if (selection?.kind === "range") {
    return cached(trackSets, selection, selection.target.track_ids);
  }
  return NONE;
}

function clipTrackId(
  project: ProjectView | null,
  clipId: string,
): string | null {
  if (!project) return null;
  for (const [trackId, list] of Object.entries(project.clips.tracks)) {
    if (list.some((c) => c.id === clipId)) return trackId;
  }
  return null;
}

function clipSelection(
  ids: readonly string[],
  primary: { id: string; trackId: string },
): Chosen {
  return ids.length === 1 && ids[0] === primary.id
    ? { kind: "clip", id: primary.id, trackId: primary.trackId }
    : { kind: "clip", id: primary.id, trackId: primary.trackId, ids };
}

function trackSelection(ids: readonly string[], primary: string): Chosen {
  return ids.length === 1 && ids[0] === primary
    ? { kind: "track", trackId: primary }
    : { kind: "track", trackId: primary, trackIds: ids };
}

/**
 * The selection a write of `next` leaves behind. A clip or track that is
 * already part of the held set keeps the set, so choosing the primary of a
 * multi-selection does not collapse it. Anything else replaces the selection.
 */
export function settleSelection(
  current: Selection,
  next: Selection,
): Selection {
  if (next?.kind === "clip") {
    const held = selectedClipIdsOf(current);
    if (next.ids) return clipSelection(next.ids, next);
    return held.includes(next.id) ? clipSelection(held, next) : next;
  }
  if (next?.kind === "track") {
    const held = current?.kind === "track" ? selectedTrackIdsOf(current) : NONE;
    if (next.trackIds) return trackSelection(next.trackIds, next.trackId);
    return held.includes(next.trackId)
      ? trackSelection(held, next.trackId)
      : next;
  }
  return next;
}

export interface ClipSelectMods {
  shift?: boolean;
  mod?: boolean;
}

/**
 * The selection after a click on a clip: Shift adds it, Mod toggles it, a plain
 * click selects it alone. Removing the primary hands the primary to the last
 * clip still held; removing the last clip clears the selection.
 */
export function clipClickSelection(
  current: Selection,
  project: ProjectView | null,
  clipId: string,
  trackId: string,
  mods?: ClipSelectMods,
): Selection {
  const held = selectedClipIdsOf(current);
  const has = held.includes(clipId);
  const asPrimary = { id: clipId, trackId };
  if (mods?.shift) {
    return clipSelection(has ? held : [...held, clipId], asPrimary);
  }
  if (mods?.mod) {
    const ids = has ? held.filter((id) => id !== clipId) : [...held, clipId];
    if (ids.length === 0) return null;
    if (has && current?.kind === "clip" && current.id === clipId) {
      const nextId = ids[ids.length - 1]!;
      return clipSelection(ids, {
        id: nextId,
        trackId:
          nextId === clipId
            ? trackId
            : (clipTrackId(project, nextId) ?? trackId),
      });
    }
    return has && current?.kind === "clip"
      ? clipSelection(ids, current)
      : clipSelection(ids, asPrimary);
  }
  return clipSelection([clipId], asPrimary);
}

/**
 * The selection after a track header click or a checkbox: additive toggles the
 * track in the held set, otherwise it selects the track alone.
 */
export function trackClickSelection(
  current: Selection,
  trackId: string,
  additive: boolean,
): Selection {
  if (!additive) return trackSelection([trackId], trackId);
  const held = current?.kind === "track" ? selectedTrackIdsOf(current) : NONE;
  const ids = held.includes(trackId)
    ? held.filter((id) => id !== trackId)
    : [...held, trackId];
  if (ids.length === 0) return null;
  return trackSelection(ids, ids.includes(trackId) ? trackId : ids.at(-1)!);
}

/** The selection naming exactly `trackIds`, the first as primary; none clears it. */
export function tracksSelection(trackIds: readonly string[]): Selection {
  return trackIds.length === 0 ? null : trackSelection(trackIds, trackIds[0]!);
}

/**
 * What the Inspector is open for. A word or timeline range keeps one key as its
 * edges move (the Inspector's own In and Out fields reshape it); every other
 * kind is its object, so selecting another one shuts the Inspector. A track and
 * its volume envelope and points are one object here: entering the envelope
 * from the track's Inspector keeps it open.
 */
export function inspectKeyOf(selection: Selection): string | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case "range":
    case "transcriptRange":
      return selection.kind;
    case "clip":
    case "pending":
    case "applied":
    case "chapter":
    case "social":
    case "comment":
      return `${selection.kind}:${selection.id}`;
    case "track":
    case "envelope":
    case "envelopePoint":
      return `track:${selection.trackId}`;
    case "bleedAttenuation":
      return `bleedAttenuation:${selection.trackId}:${selection.id}`;
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
}

/** The Inspector is open when it was opened for the selection that is still held. */
export function inspectorOpenFor(
  selection: Selection,
  inspectorKey: string | null,
): boolean {
  return inspectorKey !== null && inspectorKey === inspectKeyOf(selection);
}
