import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../utils/apiError";
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
};

export function recoveryNotice(result: KeeperRecoveryResult): string {
  if (result.recovered === 0) {
    return "No partial keeper needed recovery.";
  }
  const segments = `${result.recovered} partial ${result.recovered === 1 ? "segment" : "segments"}`;
  const trimmed =
    result.trimmed > 0
      ? " An incomplete trailing sample was dropped from the end."
      : "";
  return `Recovered ${segments}. Upload will resume.${trimmed}`;
}

export function useKeeperRecoveryActions(args: {
  sink: ByteSink | null;
  sessionId: string | null;
  participantId: string | null;
  takeIndex: number | null;
  /** Latest "room stopped and capture settled"; re-checked during recovery. */
  recoverAllowed: boolean;
  onRecovered: () => void;
}): KeeperRecoveryActions {
  const { sink, sessionId, participantId, takeIndex } = args;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const allowedRef = useRef(args.recoverAllowed);
  allowedRef.current = args.recoverAllowed;
  const onRecoveredRef = useRef(args.onRecovered);
  onRecoveredRef.current = args.onRecovered;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    (action: () => Promise<string | null>, afterSuccess?: () => void) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      void action()
        .then((message) => {
          if (!mountedRef.current) return;
          setNotice(message);
          afterSuccess?.();
        })
        .catch((failure: unknown) => {
          if (!mountedRef.current) return;
          setError(errorMessage(failure));
          // A partial run may still have recovered segments; re-poll.
          afterSuccess?.();
        })
        .finally(() => {
          busyRef.current = false;
          if (mountedRef.current) setBusy(false);
        });
    },
    [],
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
      return null;
    });
  }, [run, sink, sessionId, participantId, takeIndex]);
  const recover = useCallback(() => {
    if (!sink || !sessionId || !participantId || takeIndex === null) return;
    if (!allowedRef.current) return;
    run(
      async () =>
        recoveryNotice(
          await recoverLocalKeepers(
            sink,
            sessionId,
            participantId,
            takeIndex,
            () => allowedRef.current,
          ),
        ),
      () => onRecoveredRef.current(),
    );
  }, [run, sink, sessionId, participantId, takeIndex]);

  return {
    download: ready ? download : undefined,
    recover: ready ? recover : undefined,
    busy,
    error,
    notice,
  };
}
