import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hasCommandModifier, isTypingTarget } from "../keymap/typing";
import { useStableCallback } from "../utils/useStableCallback";
import {
  liveTakeOpen,
  loadCommentQueue,
  MARKER_BODY,
  postLiveComment,
  retainUnackedComments,
} from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

type SendFn = (
  commandType: string,
  payload: Record<string, unknown>,
  commandId?: string,
) => boolean | void;

export function useRecordLiveComments(opts: {
  token: string;
  snapshot: RecordSnapshot | null;
  me: RecordParticipant | null;
  connected: boolean;
  send: SendFn;
  captureKeys?: boolean;
}) {
  const { token, snapshot, me, connected, send, captureKeys = false } = opts;
  const [note, setNote] = useState("");
  const flushedRef = useRef<Set<string>>(new Set());
  const sendComment = useStableCallback(send);

  const post = useCallback(
    (body: string): boolean => {
      if (!snapshot || !me || !liveTakeOpen(snapshot.state)) {
        return false;
      }
      const comment = postLiveComment(sendComment, token, {
        body,
        takeIndex: snapshot.take_index,
        recordingMs: snapshot.recording_ms ?? 0,
        author: me.participant_id,
      });
      if (comment === null) {
        return false;
      }
      flushedRef.current.add(comment.id);
      return true;
    },
    [me, snapshot, token, sendComment],
  );

  const postMarker = useCallback(() => {
    post(MARKER_BODY);
  }, [post]);

  const postNote = useCallback(
    (text: string): boolean => {
      const body = text.trim();
      return body ? post(body) : false;
    },
    [post],
  );

  const submitNote = useCallback(() => {
    const body = note.trim();
    if (!body) {
      return;
    }
    post(body);
    setNote("");
  }, [note, post]);

  useEffect(() => {
    if (!connected) {
      flushedRef.current = new Set();
    }
  }, [connected]);

  const ackedKey = useMemo(
    () => (snapshot?.comments ?? []).map((row) => row.id).join("\0"),
    [snapshot?.comments],
  );

  useEffect(() => {
    const acked = new Set(ackedKey ? ackedKey.split("\0").filter(Boolean) : []);
    const remaining = connected
      ? retainUnackedComments(token, acked)
      : loadCommentQueue(token).filter((row) => !acked.has(row.id));
    if (!connected) {
      return;
    }
    for (const queued of remaining) {
      if (flushedRef.current.has(queued.id)) {
        continue;
      }
      const sent = sendComment("Comment", queued);
      if (sent !== false) {
        flushedRef.current.add(queued.id);
      }
    }
  }, [ackedKey, connected, token, sendComment]);

  useEffect(() => {
    if (!captureKeys) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "m" && event.key !== "M") {
        return;
      }
      if (hasCommandModifier(event)) {
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }
      if (!liveTakeOpen(snapshot?.state)) {
        return;
      }
      event.preventDefault();
      postMarker();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureKeys, postMarker, snapshot?.state]);

  return {
    note,
    setNote,
    postMarker,
    postNote,
    submitNote,
    comments: snapshot?.comments ?? [],
  };
}
