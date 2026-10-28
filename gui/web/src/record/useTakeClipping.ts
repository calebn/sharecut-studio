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

const NO_TAKES: Record<number, TakeClipping> = {};

/**
 * Clipping of the takes before `beforeTake`, rebuilt from OPFS keeper metadata
 * so a finished take's summary also survives a reload.
 */
export function usePastTakeClipping({
  sink,
  sessionId,
  participantId,
  beforeTake,
}: {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  beforeTake: number;
}): Record<number, TakeClipping> {
  const [stored, setStored] = useState<{
    scope: string;
    byTake: Record<number, TakeClipping>;
  }>({ scope: "", byTake: NO_TAKES });
  const scope = `${sessionId}/${participantId}`;

  useEffect(() => {
    if (!sink || !sessionId || !participantId || beforeTake <= 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (let takeIndex = 0; takeIndex < beforeTake; takeIndex += 1) {
        try {
          const value = await readTakeClipping(
            sink,
            sessionId,
            participantId,
            takeIndex,
          );
          if (cancelled) return;
          setStored((current) => ({
            scope,
            byTake: {
              ...(current.scope === scope ? current.byTake : NO_TAKES),
              [takeIndex]: value,
            },
          }));
        } catch {
          continue;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sink, sessionId, participantId, beforeTake, scope]);

  return stored.scope === scope ? stored.byTake : NO_TAKES;
}
