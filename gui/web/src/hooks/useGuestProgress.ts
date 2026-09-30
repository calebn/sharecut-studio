import { useEffect, useRef, useState } from "react";
import {
  applyCommentsFrame,
  type CommentsReplica,
} from "../review/commentsReplica";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  type GuestProgressEvent,
  guestProgressToJob,
  guestProgressWsUrl,
} from "../utils/guestProgress";

const RECONNECT_MS = 2000;
type Connection = {
  job: PipelineJobSnapshot | null;
  replica: CommentsReplica;
  initialized: boolean;
  error: string | null;
};
const emptyConnection = (): Connection => ({
  job: null,
  replica: { kind: "awaiting" },
  initialized: false,
  error: null,
});

export function useGuestProgress(token: string) {
  const scopeRef = useRef({ token });
  if (scopeRef.current.token !== token) scopeRef.current = { token };
  const scope = scopeRef.current;
  const [state, setState] = useState<{
    scope: typeof scope;
    value: Connection;
  }>(() => ({ scope, value: emptyConnection() }));
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let current = emptyConnection();
    const active = () => !closed && scopeRef.current === scope;
    const update = () => {
      if (active()) setState({ scope, value: current });
    };
    update();
    if (!token) return;
    const connect = () => {
      if (!active()) return;
      current = { ...current, initialized: false, error: null };
      update();
      const socket = new WebSocket(guestProgressWsUrl(token));
      ws = socket;
      socket.onopen = () => {
        if (!active() || socket !== ws) return;
        update();
      };
      socket.onmessage = (ev) => {
        if (!active() || socket !== ws) return;
        try {
          const raw: unknown = JSON.parse(ev.data as string);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
          if ("plane" in raw && raw.plane === "comments") {
            if (
              !current.initialized &&
              !("type" in raw && raw.type === "Snapshot")
            )
              throw new Error("Missing initial comments snapshot");
            current = {
              ...current,
              replica: applyCommentsFrame(current.replica, raw),
              initialized: true,
            };
          } else
            current = {
              ...current,
              job: guestProgressToJob(raw as GuestProgressEvent, current.job),
            };
          update();
        } catch {
          socket.close();
        }
      };
      socket.onclose = (event) => {
        if (!active() || socket !== ws) return;
        ws = null;
        const revoked = event.code === 4401 || event.code === 4403;
        current = {
          ...current,
          initialized: false,
          error: revoked ? "This review link is no longer available." : null,
        };
        update();
        if (revoked) return;
        retry = setTimeout(connect, RECONNECT_MS);
      };
      socket.onerror = () => {
        if (active() && socket === ws) socket.close();
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [token, scope]);
  const value = state.scope === scope ? state.value : emptyConnection();
  return {
    job: value.job,
    basisComments:
      value.replica.kind === "ready" ? value.replica.comments : null,
    revision: value.replica.kind === "ready" ? value.replica.revision : null,
    comments:
      value.initialized && value.replica.kind === "ready"
        ? value.replica.comments
        : null,
    healthy: value.initialized && value.replica.kind === "ready",
    error: value.error,
    scope,
  };
}
