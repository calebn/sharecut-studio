import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../../utils/apiError";
import { recordingClockMs } from "../clock";
import type { RecordRole, RecordSnapshot } from "../types";
import { type KeeperTap, openKeeperTap } from "./graph";
import { KeeperSession } from "./session";
import { SILENT_PCM_TICK_MS, SilentPcmWatchdog } from "./silenceWatchdog";
import { type ByteSink, createOpfsSink } from "./store";

type Args = {
  enabled: boolean;
  role: RecordRole;
  snapshot: RecordSnapshot | null;
  participantId: string | null;
  muted: boolean;
  consented: boolean | null;
  stream: MediaStream | null;
  sink?: ByteSink | null;
  resetKey?: number;
  onActivity?: () => void;
};

type CapturedGate = {
  role: RecordRole;
  snapshot: RecordSnapshot | null;
  participantId: string | null;
  muted: boolean;
  consented: boolean | null;
  streamAvailable: boolean;
  recordingMs: number;
};

export function useKeeperCapture({
  enabled,
  role,
  snapshot,
  participantId,
  muted,
  consented,
  stream,
  sink,
  resetKey = 0,
  onActivity,
}: Args): {
  error: string | null;
  recordingLocally: boolean;
  retry: () => void;
  finalizing: boolean;
  noAudio: boolean;
  micCheckFailed: boolean;
  checkMic: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [unfinalizedCapture, setUnfinalizedCapture] = useState(false);
  const unfinalizedCaptureRef = useRef(false);
  const [finalizing, setFinalizing] = useState(false);
  const finalizationFailed = useRef(false);
  const disposalFailed = useRef(false);
  const [epoch, setEpoch] = useState(0);
  const mountedRef = useRef(true);
  const pendingDisposals = useRef(0);
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [tapAttempt, setTapAttempt] = useState(0);
  const sessionRef = useRef<KeeperSession | null>(null);
  const tapRef = useRef<KeeperTap | null>(null);
  const [noAudio, setNoAudio] = useState(false);
  const [micCheckFailed, setMicCheckFailed] = useState(false);
  const watchdogRef = useRef(new SilentPcmWatchdog());
  const tapFailedRef = useRef(false);
  const applyChain = useRef(Promise.resolve());
  const sessionId = snapshot?.session_id ?? null;
  const clockRef = useRef({ snapshot, receivedAt: Date.now() });
  if (clockRef.current.snapshot !== snapshot) {
    clockRef.current = { snapshot, receivedAt: Date.now() };
  }
  const gateRef = useRef<CapturedGate>({
    role,
    snapshot,
    participantId,
    muted,
    consented,
    streamAvailable: stream !== null,
    recordingMs: 0,
  });
  gateRef.current = {
    role,
    snapshot,
    participantId,
    muted,
    consented,
    streamAvailable: stream !== null,
    recordingMs: 0,
  };
  const captureGate = useCallback((): CapturedGate => {
    const gate = gateRef.current;
    return {
      ...gate,
      recordingMs: gate.snapshot
        ? recordingClockMs(
            gate.snapshot,
            Date.now() - clockRef.current.receivedAt,
          )
        : 0,
    };
  }, []);
  const markUnfinalizedCapture = useCallback((value: boolean) => {
    unfinalizedCaptureRef.current = value;
    setUnfinalizedCapture(value);
  }, []);

  const applyGate = useCallback(
    async (
      session: KeeperSession,
      gate: CapturedGate,
      allowExistingError = false,
    ) => {
      if (sessionRef.current !== session) {
        return;
      }
      if (!gate.snapshot || !gate.participantId) {
        setWriting(false);
        return;
      }
      if (
        session.isWriting ||
        (gate.snapshot.state === "recording" && gate.streamAvailable)
      ) {
        markUnfinalizedCapture(true);
      }
      const existingError = session.error;
      await session.apply({
        role: gate.role,
        consented: gate.consented,
        roomState: gate.snapshot.state,
        takeIndex: gate.snapshot.take_index,
        recordingMs: gate.recordingMs,
        muted: gate.muted,
        streamAvailable: gate.streamAvailable,
        sessionId: gate.snapshot.session_id,
        participantId: gate.participantId,
      });
      if (sessionRef.current !== session) {
        return;
      }
      // KeeperSession records some OPFS close/header failures internally and
      // resolves apply() after best-effort cleanup. They still mean that the
      // local take is not durable, so the native guard must stay armed.
      if (
        session.error &&
        (!allowExistingError || session.error !== existingError)
      ) {
        throw session.error;
      }
      // Keep close protection through the asynchronous Stop/stream-loss flush.
      // The previous writable remains at risk until apply() has settled.
      markUnfinalizedCapture(session.isWriting);
      setWriting(session.isWriting && !tapFailedRef.current);
    },
    [markUnfinalizedCapture],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const disposeSession = useCallback(
    (session: KeeperSession) => {
      const guardDuringDispose =
        session.isWriting ||
        writingRef.current ||
        unfinalizedCaptureRef.current;
      if (guardDuringDispose) {
        pendingDisposals.current += 1;
        if (mountedRef.current) {
          setFinalizing(true);
        }
      }
      void session
        .dispose()
        .then(() => {
          if (session.error) {
            throw session.error;
          }
        })
        .catch((err: unknown) => {
          disposalFailed.current = true;
          finalizationFailed.current = true;
          if (mountedRef.current) {
            setError(errorMessage(err));
            setFinalizing(true);
          }
        })
        .finally(() => {
          if (guardDuringDispose) {
            pendingDisposals.current -= 1;
            if (
              mountedRef.current &&
              pendingDisposals.current === 0 &&
              !finalizationFailed.current
            ) {
              if (sessionRef.current === null) {
                markUnfinalizedCapture(false);
              }
              setFinalizing(false);
            }
          }
        });
    },
    [markUnfinalizedCapture],
  );

  useEffect(() => {
    if (!enabled || !participantId || !sessionId) {
      const existing = sessionRef.current;
      sessionRef.current = null;
      if (existing) {
        disposeSession(existing);
      }
      setWriting(false);
      return;
    }
    let cancelled = false;
    const start = async () => {
      try {
        const activeSink = sink ?? (await createOpfsSink());
        let session: KeeperSession | null = null;
        session = new KeeperSession(activeSink, (failure) => {
          if (cancelled || sessionRef.current !== session) {
            return;
          }
          setWriting(false);
          setError(failure.message);
        });
        await session.restoreCursor(
          sessionId,
          gateRef.current.snapshot?.take_index ?? -1,
          participantId,
        );
        if (cancelled) {
          await session.dispose();
          return;
        }
        sessionRef.current = session;
        await applyGate(session, captureGate());
        if (cancelled) {
          sessionRef.current = null;
          await session.dispose();
          return;
        }
        setError(null);
        setEpoch((n) => n + 1);
      } catch (err) {
        if (!cancelled) {
          setWriting(false);
          setError(errorMessage(err));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      const existing = sessionRef.current;
      sessionRef.current = null;
      if (existing) {
        disposeSession(existing);
      }
      setWriting(false);
    };
  }, [
    enabled,
    participantId,
    sessionId,
    resetKey,
    sink,
    initializationAttempt,
    applyGate,
    captureGate,
    disposeSession,
  ]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !stream) {
      return;
    }
    let cancelled = false;
    const start = async () => {
      try {
        const tap = await openKeeperTap(stream, (pcm, rate) => {
          const activeSession = sessionRef.current;
          activeSession?.push(pcm, rate);
          if (activeSession?.isWriting && !tapFailedRef.current) {
            onActivity?.();
          }
          if (watchdogRef.current.observe(pcm, performance.now())) {
            setNoAudio(false);
            setMicCheckFailed(false);
          }
        });
        if (cancelled) {
          tap.stop();
          return;
        }
        tapRef.current = tap;
        tapFailedRef.current = false;
        if (sessionRef.current === session && session.error === null) {
          setError(null);
          setWriting(session.isWriting);
        }
      } catch (err) {
        if (!cancelled) {
          tapFailedRef.current = true;
          setWriting(false);
          setError(errorMessage(err));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      tapRef.current?.stop();
      tapRef.current = null;
    };
  }, [stream, epoch, tapAttempt, onActivity]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !enabled || !sessionId || !participantId) {
      return;
    }
    // A lost stream must close its segment even if a later render reconnects
    // before this queued OPFS operation can run.
    const gate = captureGate();
    applyChain.current = applyChain.current
      .then(() => {
        if (sessionRef.current !== session) {
          return;
        }
        return applyGate(session, gate);
      })
      .catch((err: unknown) => {
        if (sessionRef.current !== session) {
          return;
        }
        // A failed Stop/pause finalization can leave an incomplete local WAV.
        // Keep native close protection armed even after writing turns false.
        finalizationFailed.current = true;
        setFinalizing(true);
        setError(errorMessage(err));
        setWriting(false);
      });
  }, [
    enabled,
    muted,
    consented,
    participantId,
    role,
    epoch,
    stream,
    applyGate,
    captureGate,
    snapshot?.state,
    snapshot?.take_index,
    sessionId,
  ]);

  const retry = () => {
    const session = sessionRef.current;
    if (!session) {
      setInitializationAttempt((n) => n + 1);
      return;
    }
    if (session.error === null) {
      if (tapFailedRef.current) {
        setTapAttempt((n) => n + 1);
      }
      return;
    }
    const retryRun = applyChain.current.then(async () => {
      if (sessionRef.current !== session) {
        return;
      }
      await applyGate(session, captureGate(), true);
      if (sessionRef.current !== session) {
        return;
      }
      await session.retry();
      if (session.error === null) {
        // A retry of the current session cannot repair an older disposed WAV.
        finalizationFailed.current = disposalFailed.current;
        markUnfinalizedCapture(session.isWriting);
        if (pendingDisposals.current === 0 && !disposalFailed.current) {
          setFinalizing(false);
        }
      }
    });
    applyChain.current = retryRun.catch(() => undefined);
    void retryRun
      .then(() => {
        if (sessionRef.current !== session) {
          return;
        }
        if (session.error === null && session.isWriting) {
          // A healthy writable is not enough until the audio tap reattaches.
          setWriting(false);
          setEpoch((n) => n + 1);
        }
      })
      .catch((err: unknown) => {
        if (sessionRef.current !== session) {
          return;
        }
        setWriting(false);
        setError(errorMessage(err));
      });
  };

  const recordingLocally = writing && stream !== null;
  const watchdogActive =
    recordingLocally && !muted && snapshot?.state === "recording";
  useEffect(() => {
    setNoAudio(false);
    setMicCheckFailed(false);
    const watchdog = watchdogRef.current;
    if (!watchdogActive) {
      watchdog.disarm();
      return;
    }
    watchdog.arm(performance.now());
    const id = setInterval(() => {
      if (watchdog.tick(performance.now())) {
        setNoAudio(true);
      }
    }, SILENT_PCM_TICK_MS);
    return () => {
      clearInterval(id);
      watchdog.disarm();
    };
  }, [watchdogActive, stream]);
  const checkMic = useCallback(() => {
    const tap = tapRef.current;
    if (!tap) {
      setTapAttempt((n) => n + 1);
      return;
    }
    void tap.resume().then((state) => {
      if (!mountedRef.current || tapRef.current !== tap) {
        return;
      }
      const track = stream?.getAudioTracks?.()[0];
      const healthy =
        state === "running" &&
        track?.readyState === "live" &&
        track.enabled !== false &&
        track.muted !== true;
      if (healthy && watchdogRef.current.isArmed) {
        watchdogRef.current.arm(performance.now());
        setNoAudio(false);
        setMicCheckFailed(false);
      } else {
        setMicCheckFailed(true);
      }
    });
  }, [stream]);
  const closeFinalizing =
    finalizing || (unfinalizedCapture && snapshot?.state === "stopped");
  useLayoutEffect(() => {
    if (!recordingLocally && !closeFinalizing) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [recordingLocally, closeFinalizing]);

  return {
    error,
    recordingLocally,
    retry,
    finalizing: closeFinalizing,
    noAudio,
    micCheckFailed,
    checkMic,
  };
}
