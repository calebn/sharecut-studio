import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import type { TimelineComment } from "../types/project";
import { clipRow, minimalProject, sampleTrack } from "./fixtures";

export const field = {
  kind: "trim",
  trackId: "host",
  clipId: "anchor",
  edge: "out",
} as const;

export function project() {
  return minimalProject({
    tracks: [sampleTrack({ id: "host" })],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "anchor",
            track_id: "host",
            source_end: 10,
            timeline_end: 10,
          }),
          clipRow({
            id: "follower",
            track_id: "host",
            source_start: 10,
            source_end: 20,
            timeline_start: 9.9996,
            timeline_end: 19.9996,
          }),
        ],
      },
      clip_count: 2,
    },
  });
}

export function initializeCommentProject(followerStart = 9.9996) {
  const comment: TimelineComment = {
    id: "review",
    body: "Keep this phrase",
    author: "Guest",
    created_at: "2026-10-09T18:00:00Z",
    updated_at: null,
    timeline_start: 2,
    timeline_end: null,
    track_ids: ["host"],
    action_items: [
      {
        id: "action",
        text: "Check the join",
        done: false,
        completed_at: null,
        completed_by: null,
      },
    ],
    replies: [],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
  };
  const origin = { ...project(), comments: [comment] };
  origin.clips.tracks.host[1]!.timeline_start = followerStart;
  origin.clips.tracks.host[1]!.timeline_end = followerStart + 10;
  useDawStore.getState().hydrate("/tmp/one.json", origin);
  applyDocumentSnapshot({ server_seq: 4, project: origin });
  return { origin, comment };
}
