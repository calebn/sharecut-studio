import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTypingTarget } from "../keymap/typing";
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
  const sendRef = useRef(send);
  sendRef.current = send;

  const post = useCallback(
    (body: string) => {
      if (!snapshot || !me || !liveTakeOpen(snapshot.state)) {
        return;
      }
      const comment = postLiveComment(sendRef.current, token, {
        body,
        takeIndex: snapshot.take_index,
        recordingMs: snapshot.recording_ms ?? 0,
        author: me.participant_id,
      });
      flushedRef.current.add(comment.id);
    },
    [me, snapshot, token],
  );

  const postMarker = useCallback(() => {
    post(MARKER_BODY);
  }, [post]);

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
      const sent = sendRef.current("Comment", queued);
      if (sent !== false) {
        flushedRef.current.add(queued.id);
      }
    }
  }, [ackedKey, connected, token]);

  useEffect(() => {
    if (!captureKeys) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "m" && event.key !== "M") {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
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
    submitNote,
    comments: snapshot?.comments ?? [],
  };
}
