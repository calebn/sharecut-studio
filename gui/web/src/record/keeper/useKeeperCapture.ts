import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordRole, RecordSnapshot } from "../types";
import { attachKeeperTap } from "./graph";
import { KeeperSession } from "./session";
import { createOpfsSink } from "./store";

type Args = {
  enabled: boolean;
  role: RecordRole;
  snapshot: RecordSnapshot | null;
  participantId: string | null;
  muted: boolean;
  consented: boolean | null;
  stream: MediaStream | null;
  resetKey?: number;
};

export function useKeeperCapture({
  enabled,
  role,
  snapshot,
  participantId,
  muted,
  consented,
  stream,
  resetKey = 0,
}: Args): { error: string | null; recordingLocally: boolean } {
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const sessionRef = useRef<KeeperSession | null>(null);
  const detachRef = useRef<(() => void) | undefined>(undefined);
  const applyChain = useRef(Promise.resolve());
  const sessionId = snapshot?.session_id ?? null;
  const gateRef = useRef({
    enabled,
    role,
    snapshot,
    participantId,
    muted,
    consented,
    streamAvailable: stream !== null,
  });
  gateRef.current = {
    enabled,
    role,
    snapshot,
    participantId,
    muted,
    consented,
    streamAvailable: stream !== null,
  };

  const applyGate = useCallback(async (session: KeeperSession) => {
    const gate = gateRef.current;
    if (!gate.snapshot || !gate.participantId) {
      setWriting(false);
      return;
    }
    await session.apply({
      role: gate.role,
      consented: gate.consented,
      roomState: gate.snapshot.state,
      takeIndex: gate.snapshot.take_index,
      recordingMs: gate.snapshot.recording_ms ?? 0,
      muted: gate.muted,
      streamAvailable: gate.streamAvailable,
      sessionId: gate.snapshot.session_id,
      participantId: gate.participantId,
    });
    setWriting(session.isWriting);
  }, []);

  useEffect(() => {
    if (!enabled || !participantId || !sessionId) {
      const existing = sessionRef.current;
      sessionRef.current = null;
      setWriting(false);
      if (existing) {
        void existing.dispose().catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }
      return;
    }
    let cancelled = false;
    const start = async () => {
      try {
        const session = new KeeperSession(await createOpfsSink());
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
        await applyGate(session);
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
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      const existing = sessionRef.current;
      sessionRef.current = null;
      setWriting(false);
      if (existing) {
        void existing.dispose().catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }
    };
  }, [enabled, participantId, sessionId, resetKey, applyGate]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !stream) {
      return;
    }
    let cancelled = false;
    const start = async () => {
      try {
        const detach = await attachKeeperTap(stream, (pcm, rate) => {
          sessionRef.current?.push(pcm, rate);
        });
        if (cancelled) {
          detach();
          return;
        }
        detachRef.current = detach;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      detachRef.current?.();
      detachRef.current = undefined;
    };
  }, [stream, epoch]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !enabled || !sessionId || !participantId) {
      return;
    }
    applyChain.current = applyChain.current
      .then(() => {
        if (sessionRef.current !== session) {
          return;
        }
        return applyGate(session);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
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
    snapshot?.state,
    snapshot?.take_index,
    sessionId,
  ]);

  const recordingLocally = writing && stream !== null;
  return { error, recordingLocally };
}
