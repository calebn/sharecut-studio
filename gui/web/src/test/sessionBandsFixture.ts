import type { RecordSessionSummary } from "../record/types";
import type { ProjectView } from "../types/project";
import { episode } from "./episodeFixture";

/** The episode with each track's clip cut in half and landed as two record sessions: `s1` is the first half, `s2` the second. */
export function recordedSessionsProject(): ProjectView {
  const base = episode();
  const tracks = Object.fromEntries(
    Object.entries(base.clips.tracks).map(([trackId, list]) => [
      trackId,
      list.flatMap((clip) => {
        const mid = (clip.timeline_start + clip.timeline_end) / 2;
        return [
          {
            ...clip,
            id: `${clip.id}-s1`,
            timeline_end: mid,
            source_end: mid,
            source_id: `rec-s1-0-${trackId}-x`,
          },
          {
            ...clip,
            id: `${clip.id}-s2`,
            timeline_start: mid,
            source_start: mid,
            source_id: `rec-s2-0-${trackId}-x`,
          },
        ];
      }),
    ]),
  );
  return { ...base, clips: { ...base.clips, tracks } };
}

const row = (
  session_id: string,
  number: number,
  name: string | null,
): RecordSessionSummary => ({
  session_id,
  number,
  planned_number: number,
  name,
  state: "ended",
  target_kind: null,
  takes: [],
  participants: [],
  landed: true,
  ended_at: null,
});

/** The host's `GET /api/record/sessions` body for `recordedSessionsProject`. */
export const RECORDED_SESSIONS_RESPONSE = {
  sessions: [row("s1", 1, null), row("s2", 2, "Pickups")],
};
