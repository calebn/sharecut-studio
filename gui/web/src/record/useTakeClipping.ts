import { useEffect, useState } from "react";
import type { TakeClipping } from "./keeper/clipRegions";
import type { ByteSink } from "./keeper/store";
import { readTakeClipping } from "./keeper/takeClipping";
import type { RecordRoomState } from "./types";

type Args = {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  takeIndex: number;
  roomState: RecordRoomState | undefined;
  /** The local keeper has finished writing (see `keeperCaptureSettled`). */
  captureSettled: boolean;
  /** Live regions from the running encoder, if any. */
  live: TakeClipping | null;
};

type Stored = { key: string; value: TakeClipping };

/**
 * The take's clipping state: live from the encoder while recording or paused,
 * then rebuilt from OPFS keeper metadata once stopped and settled, so it also
 * survives a page reload. Null when nothing is known yet.
 */
export function useTakeClipping({
  sink,
  sessionId,
  participantId,
  takeIndex,
  roomState,
  captureSettled,
  live,
}: Args): TakeClipping | null {
  const [stored, setStored] = useState<Stored | null>(null);
  const key = `${sessionId}/${takeIndex}/${participantId}`;
  const stopped = roomState === "stopped";
  const canRead =
    stopped &&
    captureSettled &&
    sink !== null &&
    sessionId !== null &&
    participantId !== null &&
    takeIndex >= 0;

  useEffect(() => {
    if (!canRead || !sink || !sessionId || !participantId) {
      return;
    }
    let cancelled = false;
    void readTakeClipping(sink, sessionId, participantId, takeIndex)
      .then((value) => {
        if (!cancelled) setStored({ key, value });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canRead, sink, sessionId, participantId, takeIndex, key]);

  const liveForTake = live && live.takeIndex === takeIndex ? live : null;
  if (roomState === "recording" || roomState === "paused") {
    return liveForTake;
  }
  if (canRead) {
    return (stored?.key === key ? stored.value : null) ?? liveForTake;
  }
  return null;
}
