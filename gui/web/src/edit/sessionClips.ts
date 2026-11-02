import type { ClipRow } from "../types/project";

const RECORD_SOURCE_ROOT = "rec-";

/** `rec-<session_id>-`, the source prefix every clip of a landed session carries (`landing_math.record_source_prefix`). */
export function recordSourcePrefix(sessionId: string): string {
  return `${RECORD_SOURCE_ROOT}${sessionId}-`;
}

/** True for a clip any record session landed. */
export function isRecordClip(clip: { source_id?: string | null }): boolean {
  return (clip.source_id ?? "").startsWith(RECORD_SOURCE_ROOT);
}

export type SessionClipSet = {
  /** Earliest `timeline_start` among the session's clips. */
  startSec: number;
  /** Latest `timeline_end`: a gap between takes stays inside the extent. */
  endSec: number;
  /** The start-most clip, the selection's primary. */
  primary: { id: string; trackId: string };
  /** Every clip of the session, in timeline order. */
  clipIds: string[];
};

export type SessionHandoff = Omit<SessionClipSet, "endSec">;

/**
 * The clips of one landed session, found by the source prefix (every participant,
 * every take; `rec-1-` never matches `rec-10-`), with their extent. Null when
 * none are on the timeline.
 */
export function sessionClipSet(
  tracks: Record<string, ClipRow[]> | undefined,
  sessionId: string,
): SessionClipSet | null {
  const prefix = recordSourcePrefix(sessionId);
  const found: { id: string; trackId: string; start: number }[] = [];
  let endSec = Number.NEGATIVE_INFINITY;
  for (const [trackId, list] of Object.entries(tracks ?? {})) {
    for (const clip of list) {
      if ((clip.source_id ?? "").startsWith(prefix)) {
        found.push({
          id: clip.id,
          trackId: clip.track_id || trackId,
          start: clip.timeline_start,
        });
        endSec = Math.max(endSec, clip.timeline_end);
      }
    }
  }
  if (found.length === 0) {
    return null;
  }
  found.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return {
    startSec: found[0].start,
    endSec,
    primary: { id: found[0].id, trackId: found[0].trackId },
    clipIds: found.map((c) => c.id),
  };
}

/**
 * What "Edit Session N" needs: the session's clips found by the same source
 * prefix as the remap. Null when none are on the timeline, so a session that has
 * not landed gets no hand-off.
 */
export function sessionHandoff(
  tracks: Record<string, ClipRow[]> | undefined,
  sessionId: string,
): SessionHandoff | null {
  const set = sessionClipSet(tracks, sessionId);
  if (!set) {
    return null;
  }
  return {
    startSec: set.startSec,
    primary: set.primary,
    clipIds: set.clipIds,
  };
}
