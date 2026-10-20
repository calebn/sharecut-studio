import { useDawStore } from "../state/dawStore";
import { selectedTrackIdsOf } from "../state/selection";

/** ``args.trackId``, else the selected clip's or track's, else the first targeted track. */
export function resolveTrackId(args: Record<string, unknown>): string | null {
  if (typeof args.trackId === "string" && args.trackId) {
    return args.trackId;
  }
  const s = useDawStore.getState();
  if (s.selection?.kind === "clip" || s.selection?.kind === "track") {
    return s.selection.trackId;
  }
  return selectedTrackIdsOf(s.selection)[0] ?? null;
}
