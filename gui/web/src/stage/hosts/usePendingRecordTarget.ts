import { useEffect, useRef } from "react";
import type {
  RecordRoomState,
  RecordSnapshot,
  SessionTarget,
} from "../../record";
import { useDawStore } from "../../state/dawStore";
import { targetLocked } from "./recordStageModel";

/**
 * Hand the target Edit parked (Re-record, Record here) to the room once. It is
 * sent while the room is in the lobby with no take; any other state means the
 * session is past choosing, so the target is dropped without a word. It also
 * waits while a command is in flight and while the room has not loaded.
 */
export function usePendingRecordTarget(
  snapshot: RecordSnapshot | null,
  state: RecordRoomState | undefined,
  busy: boolean,
  send: (target: SessionTarget) => void,
): void {
  const pending = useDawStore((s) => s.pendingRecordTarget);
  const clear = useDawStore((s) => s.setPendingRecordTarget);
  const sendRef = useRef(send);
  sendRef.current = send;
  const loaded = snapshot !== null;
  const open =
    state === "lobby" && snapshot !== null && !targetLocked(snapshot);
  useEffect(() => {
    if (!pending || !loaded || busy) {
      return;
    }
    clear(null);
    if (open) {
      sendRef.current(pending);
    }
  }, [pending, loaded, open, busy, clear]);
}
