import { useMemo } from "react";
import { useRecordSessions } from "../edit/useRecordSessions";
import { useDawStore } from "../state/dawStore";
import { sessionBands } from "./sessionBands";

/** The ids of every landed record clip: changes when a session lands, is undone, or loses a clip. */
function recordClipKey(
  tracks:
    | Record<string, { id: string; source_id?: string | null }[]>
    | undefined,
): string {
  const ids: string[] = [];
  for (const list of Object.values(tracks ?? {})) {
    for (const clip of list) {
      if ((clip.source_id ?? "").startsWith("rec-")) ids.push(clip.id);
    }
  }
  return ids.sort().join("|");
}

/**
 * The session bands the Edit ruler draws. Labels come from the host-only
 * sessions read model, so a guest (and a failed or pending fetch) gets none.
 */
export function useSessionBands() {
  const tracks = useDawStore((s) => s.project?.clips.tracks);
  const projectPath = useDawStore((s) => s.projectPath);
  const guestMode = useDawStore((s) => s.guestMode);
  const key = useMemo(() => recordClipKey(tracks), [tracks]);
  const sessions = useRecordSessions(projectPath, key, !guestMode);
  return useMemo(() => sessionBands(tracks, sessions), [tracks, sessions]);
}
