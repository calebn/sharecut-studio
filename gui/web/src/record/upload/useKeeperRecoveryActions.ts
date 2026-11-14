import { useCallback, useState } from "react";
import { useMountedRef } from "../../hooks/useMountedRef";
import { useSingleFlight } from "../../hooks/useSingleFlight";
import { errorMessage } from "../../utils/apiError";
import { useStableCallback } from "../../utils/useStableCallback";
import type { ByteSink } from "../keeper/store";
import {
  downloadLocalKeepers,
  type KeeperRecoveryResult,
  recoverLocalKeepers,
} from "./recovery";

/** Download / recover actions for retained local keepers, shared by host and guest. */
export type KeeperRecoveryActions = {
  /** Undefined until the sink, session and participant are known. */
  download?: () => void;
  recover?: () => void;
  /** True while a download or recovery run is in flight. */
  busy: boolean;
  /** Last action failure; never the OPFS storage error channel. */
  error: string | null;
  /** Last successful recovery, for the upload status live region. */
  notice: string | null;
  /** The last run was a download that handed the whole file to the browser. Any new run clears it. */
  downloaded: boolean;
};

export function recoveryNotice(
  result: KeeperRecoveryResult,
  uploadAvailable = true,
): string {
  if (result.recovered === 0) {
    return "No partial recording needed recovery.";
  }
  const segments = `${result.recovered} partial ${result.recovered === 1 ? "segment" : "segments"}`;
  const trimmed =
    result.trimmed > 0
      ? " An incomplete trailing sample was dropped from the end."
      : "";
  const next = uploadAvailable
    ? "Saving to the project will resume."
    : "Download your full-quality recording to keep a copy.";
  return `Recovered ${segments}. ${next}${trimmed}`;
}

export function useKeeperRecoveryActions(args: {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  takeIndex: number | null;
  /** Latest "room stopped and capture settled"; re-checked during recovery. */
  recoverAllowed: boolean;
  uploadAvailable?: boolean;
  onRecovered: () => void;
}): KeeperRecoveryActions {
  const { sink, sessionId, participantId, takeIndex } = args;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const { busy, run: runSingle } = useSingleFlight();
  const canRecover = useStableCallback(() => args.recoverAllowed);
  const recoveredNotice = useStableCallback((result: KeeperRecoveryResult) =>
    recoveryNotice(result, args.uploadAvailable ?? true),
  );
  const onRecovered = useStableCallback(args.onRecovered);
  const mountedRef = useMountedRef();

  const run = useCallback(
    (action: () => Promise<string | null>, afterSuccess?: () => void) => {
      void runSingle(async () => {
        setError(null);
        setNotice(null);
        setDownloaded(false);
        try {
          const message = await action();
          if (!mountedRef.current) return;
          setNotice(message);
          afterSuccess?.();
        } catch (failure: unknown) {
          if (!mountedRef.current) return;
          setError(errorMessage(failure));
          // A partial run may still have recovered segments; re-poll.
          afterSuccess?.();
        }
      });
    },
    [mountedRef, runSingle],
  );

  const ready =
    sink !== null &&
    sessionId !== null &&
    participantId !== null &&
    takeIndex !== null;
  const download = useCallback(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) return;
    run(async () => {
      await downloadLocalKeepers(sink, sessionId, participantId, takeIndex);
      setDownloaded(true);
      return null;
    });
  }, [run, sink, sessionId, participantId, takeIndex]);
  const recover = useCallback(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) return;
    if (!canRecover()) return;
    run(
      async () =>
        recoveredNotice(
          await recoverLocalKeepers(
            sink,
            sessionId,
            participantId,
            takeIndex,
            canRecover,
          ),
        ),
      onRecovered,
    );
  }, [
    run,
    sink,
    sessionId,
    participantId,
    takeIndex,
    canRecover,
    recoveredNotice,
    onRecovered,
  ]);

  return {
    download: ready ? download : undefined,
    recover: ready ? recover : undefined,
    busy,
    error,
    notice,
    downloaded,
  };
}
