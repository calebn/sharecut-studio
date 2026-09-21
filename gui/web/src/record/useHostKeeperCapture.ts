import { useEffect, useRef } from "react";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { useRecordHostStore } from "./hostStore";
import { useKeeperCapture } from "./keeper/useKeeperCapture";
import { hostKeeperResetKey, type RecordSnapshot } from "./types";
import { useMicStream } from "./useMicStream";

export function useHostKeeperCapture(enabled = true): {
  error: string | null;
  recordingLocally: boolean;
  retry: () => void;
  stream: MediaStream | null;
  muted: boolean;
  monitorEnabled: boolean;
  snapshot: RecordSnapshot | null;
  micLost: boolean;
  retryMic: () => void;
} {
  const { projectPath } = useDaw();
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const connected = useRecordHostStore((s) => s.connected);
  const pathRef = useRef(projectPath);

  useEffect(() => {
    if (pathRef.current !== projectPath) {
      pathRef.current = projectPath;
      setSnapshot(null);
    }
  }, [projectPath, setSnapshot]);

  const share = isShareProjectKey(projectPath);
  const hostOn = enabled && !share;
  const keeperLive =
    snapshot?.state === "recording" || snapshot?.state === "paused";
  const micLive = hostOn && !!snapshot;
  const host = snapshot?.participants.find(
    (person) => person.participant_id === "p_host",
  );
  const resetKey = hostKeeperResetKey(snapshot);

  const mic = useMicStream(micLive, "", resetKey);
  const keeper = useKeeperCapture({
    enabled: hostOn && keeperLive,
    role: "host",
    snapshot,
    participantId: hostOn && keeperLive ? "p_host" : null,
    muted: host?.muted ?? false,
    consented: true,
    stream: mic.stream,
    resetKey,
  });
  return {
    error: keeper.error,
    recordingLocally: keeper.recordingLocally,
    retry: keeper.retry,
    stream: mic.stream,
    muted: host?.muted ?? false,
    monitorEnabled: hostOn && !!snapshot && connected,
    snapshot,
    micLost: mic.lost,
    retryMic: mic.retry,
  };
}
