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
  scanLocalKeeper,
} from "./recovery";

/** Download / recover actions for retained local keepers, shared by host and guest. */
export type KeeperRecoveryActions = {
  /** Undefined until the sink, session and participant are known. */
  download?: () => void;
  recover?: () => void;
  /** True while a download or recovery run is in flight. */
  busy: boolean;
  /** Which action the run in flight belongs to; null while idle. */
  running?: "download" | "recover" | null;
  /** Last action failure; never the OPFS storage error channel. */
  error: string | null;
  /** Last successful recovery, for the upload status live region. */
  notice: string | null;
  /**
   * The whole zip of this session and take went to the browser: it was saved
   * once capture had settled, and the device holds no segment the zip lacks.
   * A failed download or a recovery clears it.
   */
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
  /** Segments this device holds for the take now; null while unknown. */
  localSegments: number | null;
  captureSettled: boolean;
  uploadAvailable?: boolean;
  onRecovered: () => void;
  /** After any download or recovery run ends, so the device count can be re-read. */
  onRunEnd?: () => void;
}): KeeperRecoveryActions {
  const { sink, sessionId, participantId, takeIndex } = args;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadedFor, setDownloadedFor] = useState<{
    sessionId: string;
    takeIndex: number;
    segments: number;
  } | null>(null);
  const [running, setRunning] = useState<"download" | "recover" | null>(null);
  const { busy, run: runSingle } = useSingleFlight();
  const canRecover = useStableCallback(() => args.recoverAllowed);
  const recoveredNotice = useStableCallback((result: KeeperRecoveryResult) =>
    recoveryNotice(result, args.uploadAvailable ?? true),
  );
  const onRecovered = useStableCallback(args.onRecovered);
  const onRunEnd = useStableCallback(() => args.onRunEnd?.());
  const mountedRef = useMountedRef();

  const run = useCallback(
    (
      kind: "download" | "recover",
      action: () => Promise<string | null>,
      afterSuccess?: () => void,
    ) => {
      void runSingle(async () => {
        setRunning(kind);
        setError(null);
        setNotice(null);
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
        } finally {
          if (mountedRef.current) {
            setRunning(null);
            onRunEnd();
          }
        }
      });
    },
    [mountedRef, runSingle, onRunEnd],
  );

  const ready =
    sink !== null &&
    sessionId !== null &&
    participantId !== null &&
    takeIndex !== null;
  const download = useCallback(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) return;
    run("download", async () => {
      const heldNow = async () =>
        canRecover()
          ? await scanLocalKeeper(
              sink,
              sessionId,
              participantId,
              takeIndex,
            ).catch(() => null)
          : null;
      const before = await heldNow();
      try {
        await downloadLocalKeepers(sink, sessionId, participantId, takeIndex);
      } catch (failure: unknown) {
        setDownloadedFor(null);
        throw failure;
      }
      const after = await heldNow();
      setDownloadedFor(
        before && after && canRecover() && before.segments === after.segments
          ? { sessionId, takeIndex, segments: before.segments }
          : null,
      );
      return null;
    });
  }, [run, canRecover, sink, sessionId, participantId, takeIndex]);
  const recover = useCallback(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) return;
    if (!canRecover()) return;
    run(
      "recover",
      async () => {
        setDownloadedFor(null);
        return recoveredNotice(
          await recoverLocalKeepers(
            sink,
            sessionId,
            participantId,
            takeIndex,
            canRecover,
          ),
        );
      },
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
    running,
    error,
    notice,
    downloaded:
      downloadedFor !== null &&
      downloadedFor.sessionId === sessionId &&
      downloadedFor.takeIndex === takeIndex &&
      args.captureSettled &&
      args.localSegments === downloadedFor.segments,
  };
}
