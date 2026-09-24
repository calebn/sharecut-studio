import { useDawStore } from "../state/dawStore";

/** ``args.trackId``, else the selected clip's or track's, else the first targeted track. */
export function resolveTrackId(args: Record<string, unknown>): string | null {
  if (typeof args.trackId === "string" && args.trackId) {
    return args.trackId;
  }
  const s = useDawStore.getState();
  if (s.selection?.kind === "clip" || s.selection?.kind === "track") {
    return s.selection.trackId;
  }
  if (s.selectedTrackIds[0]) {
    return s.selectedTrackIds[0];
  }
  return null;
}
