import { useMemo } from "react";
import { isRecordClip } from "../edit/sessionClips";
import { useRecordSessions } from "../edit/useRecordSessions";
import { useDawStore } from "../state/dawStore";
import { sessionBands } from "./sessionBands";

/**
 * The session bands the Edit ruler draws. Labels come from the host-only
 * sessions read model, refetched on every history change while record clips are
 * on the timeline, so a guest (and a project without a fetch yet) gets none.
 */
export function useSessionBands() {
  const tracks = useDawStore((s) => s.project?.clips.tracks);
  const headId = useDawStore((s) => s.project?.history?.head_id ?? "");
  const projectPath = useDawStore((s) => s.projectPath);
  const guestMode = useDawStore((s) => s.guestMode);
  const hasRecordClips = useMemo(
    () => Object.values(tracks ?? {}).some((list) => list.some(isRecordClip)),
    [tracks],
  );
  const sessions = useRecordSessions(
    projectPath,
    hasRecordClips ? `h:${headId}` : "",
    !guestMode,
  );
  return useMemo(() => sessionBands(tracks, sessions), [tracks, sessions]);
}
