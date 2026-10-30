import { useCallback, useEffect, useRef, useState } from "react";
import { revokeHostRoom } from "../api";
import { errorMessage } from "../utils/apiError";

export const END_SESSION_UNDO_MS = 10_000;

type Ending = { projectPath: string; sessionId: string };

type Options = {
  projectPath: string | null;
  sessionId: string | null;
  /** The room is open and no take is running. */
  canEnd: boolean;
  onEnded: () => void;
  onFailed: (message: string) => void;
};

/**
 * Ending a room revokes its links for good, so End session waits out an undo
 * window first: Undo drops the pending end and nothing was touched. Leaving the
 * stage inside the window still ends the room, as the person asked.
 */
export function useEndSession({
  projectPath,
  sessionId,
  canEnd,
  onEnded,
  onFailed,
}: Options) {
  const [ending, setEnding] = useState<Ending | null>(null);
  const [committing, setCommitting] = useState(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Ending | null>(null);
  const callbacks = useRef({ onEnded, onFailed });
  useEffect(() => {
    callbacks.current = { onEnded, onFailed };
  }, [onEnded, onFailed]);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    setEnding(null);
  }, []);

  const commit = useCallback((target: Ending) => {
    setCommitting(true);
    revokeHostRoom(target.projectPath, target.sessionId).then(
      () => {
        if (mounted.current) {
          setCommitting(false);
          callbacks.current.onEnded();
        }
      },
      (err: unknown) => {
        if (mounted.current) {
          setCommitting(false);
          callbacks.current.onFailed(errorMessage(err));
        }
      },
    );
  }, []);

  const end = useCallback(() => {
    if (
      !canEnd ||
      !projectPath ||
      !sessionId ||
      pending.current ||
      committing
    ) {
      return;
    }
    const target = { projectPath, sessionId };
    pending.current = target;
    setEnding(target);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = null;
      setEnding(null);
      commit(target);
    }, END_SESSION_UNDO_MS);
  }, [canEnd, projectPath, sessionId, commit, committing]);

  const flush = useCallback(() => {
    const target = pending.current;
    if (target) {
      clear();
      commit(target);
    }
  }, [clear, commit]);

  // A take starting or another room replacing this one withdraws the end.
  useEffect(() => {
    const target = pending.current;
    if (
      target &&
      (!canEnd ||
        target.projectPath !== projectPath ||
        target.sessionId !== sessionId)
    ) {
      clear();
    }
  }, [canEnd, projectPath, sessionId, clear]);

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      flushRef.current();
      mounted.current = false;
    };
  }, []);

  return { ending: ending !== null, busy: committing, end, undo: clear };
}
