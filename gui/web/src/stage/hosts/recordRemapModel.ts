import { allClipsFromTracks, type ClipMoveItem } from "../../edit/clipMove";
import type { ClipRow } from "../../types/project";

/** `rec-<session_id>-`, the source prefix every clip of a landed session carries (`landing_math.record_source_prefix`). */
export function recordSourcePrefix(sessionId: string): string {
  return `rec-${sessionId}-`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The clips one participant landed in one session: the source id starts with the
 * session prefix and the rest is `<take>-<participant_id>-...`, the same test as
 * the server's `sessions._landed_tracks`. `rec-1-` never matches `rec-10-`.
 */
export function participantClips(
  clips: readonly ClipRow[],
  sessionId: string,
  participantId: string,
): ClipRow[] {
  const prefix = recordSourcePrefix(sessionId);
  const rest = new RegExp(`^\\d+-${escapeRegExp(participantId)}-`);
  return clips.filter((clip) => {
    const source = clip.source_id ?? "";
    return source.startsWith(prefix) && rest.test(source.slice(prefix.length));
  });
}

/** Every landed participant's clip ids; a participant with none is absent. */
export function movableParticipants(
  tracks: Record<string, ClipRow[]> | undefined,
  sessionId: string,
  participantIds: readonly string[],
): Set<string> {
  const all = allClipsFromTracks(tracks ?? {});
  return new Set(
    participantIds.filter(
      (id) => participantClips(all, sessionId, id).length > 0,
    ),
  );
}

/** Moves of all the participant's session clips onto `trackId`, each keeping its start. */
export function remapMoves(
  tracks: Record<string, ClipRow[]> | undefined,
  sessionId: string,
  participantId: string,
  trackId: string,
): ClipMoveItem[] {
  return participantClips(
    allClipsFromTracks(tracks ?? {}),
    sessionId,
    participantId,
  ).map((clip) => ({
    clip_id: clip.id,
    timeline_start: clip.timeline_start,
    track_id: trackId,
  }));
}

/** Which track each clip of the session is on; changes when any of them moves, is added or removed. */
export function sessionClipSignature(
  tracks: Record<string, ClipRow[]> | undefined,
  sessionId: string,
): string {
  const prefix = recordSourcePrefix(sessionId);
  return allClipsFromTracks(tracks ?? {})
    .filter((clip) => (clip.source_id ?? "").startsWith(prefix))
    .map((clip) => `${clip.id}:${clip.track_id}`)
    .sort()
    .join("|");
}
