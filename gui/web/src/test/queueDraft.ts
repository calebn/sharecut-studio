import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";

let next = 0;

/**
 * Stand-in for a mocked `moveClips` that acts like the real queue: the MoveClips
 * draft begins before the first await and ends when the command settles.
 */
export function movingLikeTheQueue<T>(
  settle: (path: string, clips: unknown) => Promise<T>,
) {
  return (
    path: string,
    clips: { clip_id: string; timeline_start: number; track_id: string }[],
  ) => {
    const id = `test-move-${next++}`;
    beginDocumentDraft(id, "MoveClips", { clips });
    return settle(path, clips).finally(() => finishDocumentDraft(id));
  };
}
