import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../utils/apiError";
import { encodeRoomToneWav } from "./encodeRoomTone";
import type { ByteSink } from "./keeper/store";
import { removeBestEffort, roomToneWavPath } from "./keeper/store";
import {
  type RoomToneClock,
  type RoomToneDelivery,
  type RoomToneStatus,
  roomToneClock,
  roomToneReady,
  roomToneTooLoud,
} from "./roomTone";
import {
  ROOM_TONE_LAND_FAILED_COPY,
  ROOM_TONE_MIN_SEC,
  ROOM_TONE_NOT_READY_COPY,
} from "./types";
import { uploadRoomToneWav } from "./upload/roomTone";
import type { RecordUploadTransport } from "./upload/transport";

export function useRoomToneCapture(args: {
  enabled: boolean;
  canUpload: boolean;
  stream: MediaStream | null;
  sessionId: string | null;
  participantId: string | null;
  sink: ByteSink | null;
  transport: RecordUploadTransport | null;
}): {
  status: RoomToneStatus;
  delivery: RoomToneDelivery;
  error: string | null;
  ready: boolean;
  captureReady: boolean;
  /** Seconds left of the take and how much of it is used; full while idle. */
  clock: RoomToneClock;
  record: () => void;
  /** Stops a take where it is; it is kept when at least `ROOM_TONE_MIN_SEC` long. */
  endEarly: () => void;
  /** Drops a take under way and goes back to idle. */
  cancel: () => void;
  skip: () => void;
  retry: () => void;
} {
  const [status, setStatus] = useState<RoomToneStatus>("idle");
  const [delivery, setDelivery] = useState<RoomToneDelivery>("device");
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const [clock, setClock] = useState<RoomToneClock>(() => roomToneClock(0));
  const pendingWav = useRef<Uint8Array | null>(null);
  // Set before the first part is sent: a cancel that lands between parts still has a bed to revoke.
  const uploaded = useRef(false);
  // The running take or deferred upload, so a drop can wait for it to stop touching storage and the server.
  const runRef = useRef<Promise<void> | null>(null);
  const generation = useRef(0);

  const captureReady = Boolean(
    args.enabled &&
      args.stream &&
      args.sessionId &&
      args.participantId &&
      args.sink,
  );

  const discardLocal = useCallback(async () => {
    pendingWav.current = null;
    if (!args.sink || !args.sessionId || !args.participantId) {
      return;
    }
    // Disposable bed: a refused delete must not block revoke or status.
    await removeBestEffort(
      args.sink,
      roomToneWavPath(args.sessionId, args.participantId),
    );
  }, [args.participantId, args.sessionId, args.sink]);

  const revokeRemote = useCallback(
    async (signal?: AbortSignal) => {
      if (!uploaded.current) {
        return;
      }
      uploaded.current = false;
      await args.transport?.revokeRoomTone?.(signal);
    },
    [args.transport],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (status !== "capturing") {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setClock((now) => {
        if (now.saving) {
          return now;
        }
        const next = roomToneClock((Date.now() - startedAt) / 1000);
        return next.remainingSec === now.remainingSec ? now : next;
      });
    }, 250);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (args.enabled) {
      return;
    }
    abortRef.current?.abort();
    const settling = runRef.current;
    void (async () => {
      // A write still in flight would otherwise land after the delete.
      await settling?.catch(() => undefined);
      if (!uploaded.current) {
        await discardLocal();
      }
    })();
  }, [args.enabled, discardLocal]);

  const flushUpload = useCallback(
    async (controller: AbortController, wav: Uint8Array) => {
      if (!args.canUpload || !args.transport) {
        return;
      }
      uploaded.current = true;
      const ack = await uploadRoomToneWav({
        wav,
        transport: args.transport,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      // A bed the host received but could not register is not sent: say so and offer a retake.
      if (ack.landFailed) {
        throw new Error(ROOM_TONE_LAND_FAILED_COPY);
      }
      // "Sent" waits for the host's file ack.
      if (ack.fileAck) {
        setDelivery("host");
      }
    },
    [args.canUpload, args.transport],
  );

  useEffect(() => {
    if (
      !args.canUpload ||
      !args.transport ||
      status !== "recorded" ||
      uploaded.current ||
      !pendingWav.current ||
      inflight.current
    ) {
      return;
    }
    inflight.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const wav = pendingWav.current;
    runRef.current = (async () => {
      try {
        await flushUpload(controller, wav);
        if (abortRef.current !== controller) {
          return;
        }
      } catch (err) {
        if (controller.signal.aborted || abortRef.current !== controller) {
          return;
        }
        setStatus("error");
        setError(errorMessage(err));
      } finally {
        if (abortRef.current === controller) {
          inflight.current = false;
        }
      }
    })();
  }, [args.canUpload, args.transport, flushUpload, status]);

  const record = useCallback(() => {
    if (inflight.current) {
      return;
    }
    if (
      !args.enabled ||
      !args.stream ||
      !args.sessionId ||
      !args.participantId ||
      !args.sink
    ) {
      if (args.enabled && args.stream) {
        setStatus("error");
        setError(ROOM_TONE_NOT_READY_COPY);
      }
      return;
    }
    inflight.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const stop = new AbortController();
    stopRef.current = stop;
    setClock(roomToneClock(0));
    setStatus("capturing");
    setError(null);
    setDelivery("device");
    generation.current += 1;
    // An earlier bed, here or on the host, goes before this take can replace it,
    // so what the row says and what the host holds agree whatever this take does.
    const stale = Promise.all([
      uploaded.current
        ? args.transport?.revokeRoomTone?.(controller.signal)
        : undefined,
      removeBestEffort(
        args.sink,
        roomToneWavPath(args.sessionId, args.participantId),
      ),
    ]).then(() => undefined);
    void stale.catch(() => undefined);
    uploaded.current = false;
    pendingWav.current = null;
    const stream = args.stream;
    const sessionId = args.sessionId;
    const participantId = args.participantId;
    const sink = args.sink;
    runRef.current = (async () => {
      try {
        const encoded = await encodeRoomToneWav(stream, {
          signal: controller.signal,
          stopSignal: stop.signal,
        });
        controller.signal.throwIfAborted();
        await stale;
        controller.signal.throwIfAborted();
        if (encoded.durationSec < ROOM_TONE_MIN_SEC) {
          if (abortRef.current === controller) {
            setStatus("too_short");
          }
          return;
        }
        const path = roomToneWavPath(sessionId, participantId);
        await sink.write(path, encoded.wav);
        controller.signal.throwIfAborted();
        if (roomToneTooLoud(encoded.samples)) {
          pendingWav.current = null;
          await removeBestEffort(sink, path);
          if (abortRef.current !== controller) {
            return;
          }
          setStatus("too_loud");
          return;
        }
        pendingWav.current = encoded.wav;
        if (args.canUpload) {
          await flushUpload(controller, encoded.wav);
        }
        controller.signal.throwIfAborted();
        if (abortRef.current !== controller) {
          return;
        }
        setStatus("recorded");
      } catch (err) {
        if (controller.signal.aborted || abortRef.current !== controller) {
          // Cancelled with nothing taking its place, such as a take starting.
          if (abortRef.current === controller) {
            setStatus((now) => (now === "capturing" ? "idle" : now));
          }
          return;
        }
        setStatus("error");
        setError(errorMessage(err));
      } finally {
        if (abortRef.current === controller) {
          inflight.current = false;
        }
      }
    })();
  }, [
    args.canUpload,
    args.enabled,
    args.participantId,
    args.sessionId,
    args.sink,
    args.stream,
    args.transport,
    flushUpload,
  ]);

  const endEarly = useCallback(() => {
    if (status !== "capturing") {
      return;
    }
    // The take is over: stop the clock and say it is saving while the tail finishes.
    setClock((now) => ({ ...now, saving: true }));
    stopRef.current?.abort();
  }, [status]);

  const drop = useCallback(
    (next: "skipped" | "idle") => {
      abortRef.current?.abort();
      // The aborted take's cleanup runs a tick later; a new take must not wait for it.
      inflight.current = false;
      const dropped = generation.current;
      const settling = runRef.current;
      setError(null);
      setStatus(next);
      void (async () => {
        // Wait out a write or part in flight, or it would land after the delete or revoke.
        await settling?.catch(() => undefined);
        if (generation.current !== dropped) {
          return;
        }
        try {
          await discardLocal();
        } finally {
          try {
            await revokeRemote();
          } catch {
            // Dropping stays local-first; never leave an unhandled rejection.
          }
        }
      })();
    },
    [discardLocal, revokeRemote],
  );

  const skip = useCallback(() => drop("skipped"), [drop]);

  const cancel = useCallback(() => {
    if (status === "capturing") {
      drop("idle");
    }
  }, [drop, status]);

  const retry = useCallback(() => {
    if (inflight.current) {
      return;
    }
    abortRef.current?.abort();
    pendingWav.current = null;
    setError(null);
    setStatus("idle");
  }, []);

  return {
    status,
    delivery,
    error,
    ready: roomToneReady(status),
    captureReady,
    clock,
    record,
    endEarly,
    cancel,
    skip,
    retry,
  };
}
