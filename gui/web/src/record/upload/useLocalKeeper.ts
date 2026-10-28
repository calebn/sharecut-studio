import { useEffect, useState } from "react";
import type { ByteSink } from "../keeper/store";
import { hasLocalKeeper } from "./recovery";

/**
 * Whether a keeper WAV for this participant is still on the device, read from
 * the sink (so it survives a reload). False while the check is pending or
 * fails, and for a different session or participant than the last answer.
 * `recheck` changes when the answer may have changed (a run finished).
 */
export function useLocalKeeper(args: {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  takeIndex: number | null;
  recheck: unknown;
}): boolean {
  const { sink, sessionId, participantId, takeIndex, recheck } = args;
  const [answer, setAnswer] = useState<{
    sink: ByteSink;
    sessionId: string;
    participantId: string;
    found: boolean;
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recheck re-runs the probe on purpose
  useEffect(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) {
      return;
    }
    let live = true;
    void hasLocalKeeper(sink, sessionId, participantId, takeIndex)
      .catch(() => false)
      .then((found) => {
        if (live) setAnswer({ sink, sessionId, participantId, found });
      });
    return () => {
      live = false;
    };
  }, [sink, sessionId, participantId, takeIndex, recheck]);

  return (
    answer !== null &&
    answer.sink === sink &&
    answer.sessionId === sessionId &&
    answer.participantId === participantId &&
    answer.found
  );
}
