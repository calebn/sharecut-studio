import { useEffect, useRef } from "react";
import type {
  RecordRoomLookup,
  RecordRoomState,
  RecordSnapshot,
  SessionTarget,
} from "../../record";
import { useDawStore } from "../../state/dawStore";
import { targetLocked } from "./recordStageModel";

type PendingRecordTargetRoom = {
  snapshot: RecordSnapshot | null;
  state: RecordRoomState | undefined;
  /** This project's room lookup finished (a room made since leaves it `none`); an earlier project's snapshot may still be in the store before that. */
  lookup: RecordRoomLookup;
  /** The host can drive the room. */
  controlled: boolean;
  busy: boolean;
};

/**
 * Hand the target Edit parked (Re-record, Record here) to the room once. It is
 * sent while the room is in the lobby with no take; any other state means the
 * session is past choosing, so the target is dropped without a word. It waits
 * while the room has not loaded for this project, while the host cannot drive
 * it, and while a command is in flight.
 */
export function usePendingRecordTarget(
  room: PendingRecordTargetRoom,
  send: (target: SessionTarget) => void,
): void {
  const pending = useDawStore((s) => s.pendingRecordTarget);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const { snapshot, state, lookup, controlled, busy } = room;
  const ready =
    snapshot !== null &&
    (lookup === "found" || lookup === "none") &&
    controlled &&
    !busy;
  const open =
    ready && state === "lobby" && snapshot !== null && !targetLocked(snapshot);
  useEffect(() => {
    if (!pending || !ready) {
      return;
    }
    // Read and clear in the store, so a replayed effect finds it already gone.
    const store = useDawStore.getState();
    const target = store.pendingRecordTarget;
    if (!target) {
      return;
    }
    store.setPendingRecordTarget(null);
    if (open) {
      if (target.kind === "replace") {
        const { script, ...wire } = target;
        store.setRecordScript(
          script
            ? {
                fromSec: wire.from_sec,
                toSec: wire.to_sec,
                trackIds: [...wire.track_ids],
                text: script,
              }
            : null,
        );
        sendRef.current(wire);
      } else {
        store.setRecordScript(null);
        sendRef.current(target);
      }
    } else {
      store.setRecordScript(null);
    }
  }, [pending, ready, open]);
}
