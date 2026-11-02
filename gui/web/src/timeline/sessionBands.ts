import { sessionClipSet } from "../edit/sessionClips";
import type { ClipRow } from "../types/project";

export type SessionBand = {
  sessionId: string;
  number: number;
  label: string;
  /** The full name for hover and the button's name: `Session 2`, or `Session 2 - Name`. */
  title: string;
  start: number;
  end: number;
  clipIds: string[];
  primary: { id: string; trackId: string };
};

type SessionRow = {
  session_id: string;
  /** Null until the session has landed. */
  number: number | null;
  name: string | null;
};

/**
 * One band per numbered session whose clips are on the timeline, in start order
 * (number breaks ties). The extent is derived from the clips, so a session whose
 * clips were all deleted has no band, and sessions that overlap
 * (a replace or insert target) each keep their own band.
 */
export function sessionBands(
  tracks: Record<string, ClipRow[]> | undefined,
  sessions: readonly SessionRow[],
): SessionBand[] {
  const bands: SessionBand[] = [];
  for (const row of sessions) {
    if (row.number == null) continue;
    const set = sessionClipSet(tracks, row.session_id);
    if (!set || set.endSec <= set.startSec) continue;
    bands.push({
      sessionId: row.session_id,
      number: row.number,
      label: `S${row.number}`,
      title: row.name
        ? `Session ${row.number} - ${row.name}`
        : `Session ${row.number}`,
      start: set.startSec,
      end: set.endSec,
      clipIds: set.clipIds,
      primary: set.primary,
    });
  }
  return bands.sort((a, b) => a.start - b.start || a.number - b.number);
}

export function bandSelected(
  band: Pick<SessionBand, "clipIds">,
  selectedIds: readonly string[],
): boolean {
  return (
    selectedIds.length === band.clipIds.length &&
    band.clipIds.every((id) => selectedIds.includes(id))
  );
}
