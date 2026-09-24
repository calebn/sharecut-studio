import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { loadSessionMeta, loadSessionState, postSessionState } from "../api";
import { applyServerClock } from "../presence/clock";
import { usePresencePublisher } from "../presence/usePresencePublisher";
import { useRecordHostStore } from "../record/hostStore";
import { bindRecordHostSend } from "../record/hostWire";
import { emitRecordSignal, isRecordSignal } from "../record/monitor/signalBus";
import { newClientId } from "../session/clientId";
import {
  type AppliedCursor,
  advanceCursorIfNewer,
  baselineFromSnapshot,
  shouldApplyRemote,
  shouldHandleWsMessage,
} from "../session/dedupe";
import { bindWsSender } from "../session/wsSend";
import { getSessionToken } from "../sessionAuth";
import { useDawStore } from "../state/dawStore";
import type { SessionState, ViewerSessionSnapshot } from "../types/session";
import { useFileMetaPoll } from "./useFileMetaPoll";

const FALLBACK_POLL_MS = 1500;
const PLAYHEAD_HEARTBEAT_MS = 200;
const DISCRETE_DEBOUNCE_MS = 50;

function wsUrl(projectPath: string, clientId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    path: projectPath,
    client_id: clientId,
    role: "viewer",
    label: "Host",
  });
  const tok = getSessionToken();
  if (tok) {
    q.set("token", tok);
  }
  return `${proto}://${window.location.host}/api/session/ws?${q.toString()}`;
}

/**
 * Session sync: WebSocket primary (Applied fanout), HTTP publish + mtime fallback.
 *
 * Presence publishes over WS; durable deltas still POST /api/session/state.
 * See docs/gui-integration.md § Shared session state.
 */
export function useSessionSync(
  projectPath: string,
  applyAgentSession: (state: SessionState) => void,
  buildViewerSnapshot: () => ViewerSessionSnapshot,
  suppressPublish: boolean,
  lastAppliedRevision: number,
  lastAppliedCommandId: string | null,
  isPlaying: boolean,
  publishKey: string,
  enabled = true,
): void {
  const clientIdRef = useRef(newClientId());
  const sendRef = useRef<((frame: Record<string, unknown>) => void) | null>(
    null,
  );
  const [wsReady, setWsReady] = useState(false);
  const cursorRef = useRef<AppliedCursor>({
    serverSeq: lastAppliedRevision,
    commandId: lastAppliedCommandId,
  });
  const mtimeRef = useRef<number | null>(null);
  const applyAgentSessionRef = useRef(applyAgentSession);
  applyAgentSessionRef.current = applyAgentSession;

  cursorRef.current = {
    serverSeq: Math.max(cursorRef.current.serverSeq, lastAppliedRevision),
    commandId: lastAppliedCommandId,
  };

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    useDawStore.getState().setLocalClientId(clientIdRef.current);
  }, [enabled]);

  const applyRemote = useCallback(
    (
      state: SessionState,
      commandType?: string | null,
      commandClientId?: string | null,
    ) => {
      const { apply, next } = shouldApplyRemote(state, cursorRef.current, {
        commandType,
        localPlaying: isPlayingRef.current,
        localClientId: clientIdRef.current,
        commandClientId,
      });
      if (!apply) {
        cursorRef.current = {
          serverSeq: Math.max(next.serverSeq, cursorRef.current.serverSeq),
          commandId: next.commandId,
        };
        return;
      }
      cursorRef.current = next;
      applyAgentSessionRef.current(state);
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    let cancelled = false;
    let retry: number | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (cancelled) {
        return;
      }
      socket = new WebSocket(wsUrl(projectPath, clientIdRef.current));
      const thisSocket = socket;
      socket.onopen = () => {
        sendRef.current = bindWsSender(thisSocket);
        bindRecordHostSend(sendRef.current);
        setWsReady(true);
        useRecordHostStore.getState().setConnected(true);
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            plane?: string;
            server_time_ns?: number;
            clients?: SessionState["clients"];
            snapshot?: SessionState & { participants?: unknown };
            command?: { role?: string; type?: string; client_id?: string };
          };
          applyServerClock(msg.server_time_ns ?? msg.snapshot?.server_time_ns);
          if (msg.plane === "record" && isRecordSignal(msg)) {
            emitRecordSignal(msg);
            return;
          }
          if (msg.plane === "record" && msg.snapshot) {
            useRecordHostStore
              .getState()
              .setSnapshot(
                msg.snapshot as unknown as import("../record/types").RecordSnapshot,
              );
            return;
          }
          if (msg.type === "Presence" && Array.isArray(msg.clients)) {
            useDawStore.getState().setSessionClients(msg.clients);
            return;
          }
          if (
            (msg.type === "Snapshot" ||
              msg.type === "Applied" ||
              msg.type === "Echo") &&
            msg.snapshot
          ) {
            const snap = msg.snapshot;
            if (Array.isArray(snap.clients)) {
              useDawStore.getState().setSessionClients(snap.clients);
            }
            if (msg.type === "Snapshot" && cursorRef.current.serverSeq === 0) {
              const { apply, next } = baselineFromSnapshot(
                snap,
                cursorRef.current,
              );
              if (apply) {
                applyAgentSessionRef.current(snap);
              }
              cursorRef.current = next;
              return;
            }
            if (
              shouldHandleWsMessage(
                { type: msg.type, command: msg.command, snapshot: snap },
                cursorRef.current,
                {
                  localPlaying: isPlayingRef.current,
                  localClientId: clientIdRef.current,
                },
              )
            ) {
              applyRemote(
                snap,
                msg.command?.type,
                msg.command?.client_id ?? snap.last_client_id,
              );
            } else {
              cursorRef.current = advanceCursorIfNewer(cursorRef.current, snap);
            }
          }
        } catch {
          // ignore malformed
        }
      };
      socket.onclose = () => {
        if (socket !== thisSocket) {
          return;
        }
        sendRef.current = null;
        bindRecordHostSend(null);
        setWsReady(false);
        useRecordHostStore.getState().setConnected(false);
        if (!cancelled) {
          retry = window.setTimeout(connect, 1000);
        }
      };
      socket.onerror = () => {
        if (socket === thisSocket) {
          socket?.close();
        }
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (retry != null) {
        window.clearTimeout(retry);
      }
      bindRecordHostSend(null);
      socket?.close();
      sendRef.current = null;
      setWsReady(false);
      useRecordHostStore.getState().setConnected(false);
    };
  }, [projectPath, enabled, applyRemote]);

  const sendPresence = useCallback((frame: Record<string, unknown>) => {
    sendRef.current?.(frame);
  }, []);
  usePresencePublisher(wsReady ? sendPresence : null, "Host");

  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadSessionMeta(projectPath),
    async () => {
      const state = await loadSessionState(projectPath);
      if (state) {
        applyRemote(state);
      }
    },
    FALLBACK_POLL_MS,
  );

  const publishHttp = useEffectEvent(async () => {
    const snap = {
      ...buildViewerSnapshot(),
      client_id: clientIdRef.current,
      label: "Host",
    };
    const written = await postSessionState(projectPath, snap);
    mtimeRef.current = null;
    const meta = await loadSessionMeta(projectPath);
    if (meta.exists) {
      mtimeRef.current = meta.mtime_ns;
    }
    cursorRef.current = advanceCursorIfNewer(cursorRef.current, written);
  });

  useEffect(() => {
    if (!enabled || !projectPath || suppressPublish) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!cancelled) {
            await publishHttp();
          }
        } catch {
          // Transient
        }
      })();
    }, DISCRETE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectPath, suppressPublish, publishKey, enabled]);

  useEffect(() => {
    if (!enabled || !projectPath || suppressPublish || !isPlaying || wsReady) {
      return;
    }
    let cancelled = false;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          if (!cancelled) {
            await publishHttp();
          }
        } catch {
          // Transient
        }
      })();
    }, PLAYHEAD_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectPath, suppressPublish, isPlaying, enabled, wsReady]);
}
