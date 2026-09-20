import { useCallback, useEffect, useRef, useState } from "react";
import { encodeRoomToneWav } from "./encodeRoomTone";
import type { ByteSink } from "./keeper/store";
import { roomToneWavPath } from "./keeper/store";
import {
  type RoomToneStatus,
  roomToneReady,
  roomToneTooLoud,
} from "./roomTone";
import { ROOM_TONE_NOT_READY_COPY } from "./types";
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
  error: string | null;
  ready: boolean;
  captureReady: boolean;
  record: () => void;
  skip: () => void;
  retry: () => void;
} {
  const [status, setStatus] = useState<RoomToneStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingWav = useRef<Uint8Array | null>(null);
  const uploaded = useRef(false);

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
    await args.sink.remove(roomToneWavPath(args.sessionId, args.participantId));
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
    if (args.enabled) {
      return;
    }
    abortRef.current?.abort();
    if (!uploaded.current) {
      void discardLocal();
    }
  }, [args.enabled, discardLocal]);

  const flushUpload = useCallback(
    async (controller: AbortController, wav: Uint8Array) => {
      if (!args.canUpload || !args.transport) {
        return;
      }
      await uploadRoomToneWav({
        wav,
        transport: args.transport,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      uploaded.current = true;
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
    void (async () => {
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
        setError(err instanceof Error ? err.message : String(err));
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
    setStatus("capturing");
    setError(null);
    uploaded.current = false;
    pendingWav.current = null;
    const stream = args.stream;
    const sessionId = args.sessionId;
    const participantId = args.participantId;
    const sink = args.sink;
    void (async () => {
      try {
        const encoded = await encodeRoomToneWav(stream, {
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        const path = roomToneWavPath(sessionId, participantId);
        await sink.write(path, encoded.wav);
        controller.signal.throwIfAborted();
        if (roomToneTooLoud(encoded.samples)) {
          pendingWav.current = null;
          await sink.remove(path);
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
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
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
    flushUpload,
  ]);

  const skip = useCallback(() => {
    abortRef.current?.abort();
    setError(null);
    setStatus("skipped");
    void (async () => {
      await discardLocal();
      await revokeRemote();
    })();
  }, [discardLocal, revokeRemote]);

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
    error,
    ready: roomToneReady(status),
    captureReady,
    record,
    skip,
    retry,
  };
}
