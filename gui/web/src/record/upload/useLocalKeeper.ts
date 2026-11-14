import { useEffect, useRef, useState } from "react";
import type { ByteSink } from "../keeper/store";
import { scanLocalKeeper } from "./recovery";

/** `segments` is null while the device has not been read or the read failed. */
export type LocalKeeper = { found: boolean; segments: number | null };

const UNKNOWN: LocalKeeper = { found: false, segments: null };

const RETRY_AFTER_MS = 2000;

/**
 * Whether a keeper WAV for this participant is still on the device, read from
 * the sink (so it survives a reload). False while the check is pending or
 * fails, and for a different session or participant than the last answer.
 * `segments` counts the segment slots the device holds, for comparing with
 * what the last upload pass saw. `recheck` changes when the answer may have
 * changed (a run finished). A failed scan is tried once more after a short
 * delay for each `recheck` value.
 */
export function useLocalKeeper(args: {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  takeIndex: number | null;
  recheck: unknown;
}): LocalKeeper {
  const { sink, sessionId, participantId, takeIndex, recheck } = args;
  const [answer, setAnswer] = useState<{
    sink: ByteSink;
    sessionId: string;
    participantId: string;
    keeper: LocalKeeper;
  } | null>(null);

  const [retry, setRetry] = useState(0);
  const retriedFor = useRef<unknown>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recheck re-runs the probe on purpose
  useEffect(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void scanLocalKeeper(sink, sessionId, participantId, takeIndex)
      .catch(() => null)
      .then((keeper) => {
        if (!live) return;
        setAnswer({
          sink,
          sessionId,
          participantId,
          keeper: keeper ?? UNKNOWN,
        });
        if (keeper === null && retriedFor.current !== recheck) {
          retriedFor.current = recheck;
          timer = setTimeout(
            () => setRetry((count) => count + 1),
            RETRY_AFTER_MS,
          );
        }
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sink, sessionId, participantId, takeIndex, recheck, retry]);

  return answer !== null &&
    answer.sink === sink &&
    answer.sessionId === sessionId &&
    answer.participantId === participantId
    ? answer.keeper
    : UNKNOWN;
}
