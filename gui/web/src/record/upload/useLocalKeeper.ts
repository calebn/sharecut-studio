import { useEffect, useState } from "react";
import type { ByteSink } from "../keeper/store";
import { scanLocalKeeper } from "./recovery";

export type LocalKeeper = { found: boolean; segments: number };

const NONE: LocalKeeper = { found: false, segments: 0 };

/**
 * Whether a keeper WAV for this participant is still on the device, read from
 * the sink (so it survives a reload). False while the check is pending or
 * fails, and for a different session or participant than the last answer.
 * `segments` counts the segment slots the device holds, for comparing with
 * what the last upload pass saw. `recheck` changes when the answer may have
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
      .catch(() => NONE)
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
    : NONE;
}
