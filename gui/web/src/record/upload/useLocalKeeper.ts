import { useEffect, useState } from "react";
import type { ByteSink } from "../keeper/store";
import { scanLocalKeeper } from "./recovery";

/** `segments` is null while the device has not been read or the read failed. */
export type LocalKeeper = { found: boolean; segments: number | null };

const UNKNOWN: LocalKeeper = { found: false, segments: null };

/**
 * Whether a keeper WAV for this participant is still on the device, read from
 * the sink (so it survives a reload). False while the check is pending or
 * fails, and for a different session or participant than the last answer.
 * `segments` counts the segment slots the device holds, for comparing with
 * what the last upload pass saw, and is null while that count is unknown. `recheck` changes when the answer may have
 * changed (a run finished).
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: recheck re-runs the probe on purpose
  useEffect(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) {
      return;
    }
    let live = true;
    void scanLocalKeeper(sink, sessionId, participantId, takeIndex)
      .catch(() => UNKNOWN)
      .then((keeper) => {
        if (live) setAnswer({ sink, sessionId, participantId, keeper });
      });
    return () => {
      live = false;
    };
  }, [sink, sessionId, participantId, takeIndex, recheck]);

  return answer !== null &&
    answer.sink === sink &&
    answer.sessionId === sessionId &&
    answer.participantId === participantId
    ? answer.keeper
    : UNKNOWN;
}
