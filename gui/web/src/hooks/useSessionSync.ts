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
  sessionPollAlreadyApplied,
  shouldApplyRemote,
  shouldHandleWsMessage,
} from "../session/dedupe";
import { bindWsSender, type WsSender } from "../session/wsSend";
import { getSessionToken } from "../sessionAuth";
import { useDawStore } from "../state/dawStore";
import type { SessionState, ViewerSessionSnapshot } from "../types/session";
import { useFileMetaPoll } from "./useFileMetaPoll";

const PLAYHEAD_HEARTBEAT_MS = 200;
const DISCRETE_DEBOUNCE_MS = 50;

/**
 * No own-client `ViewerState` Echo within this window of the oldest unechoed
 * send: republish over HTTP. Fixed, not RTT-scaled: on a live socket slower
 * than this (high-latency relay/tunnel) the Echo lands after the fallback and
 * each debounced change costs one redundant `POST /api/session/state`. That is
 * harmless because `publish_viewer_snapshot` re-diffs and journals only changed
 * fields.
 */
const VIEWER_STATE_ECHO_TIMEOUT_MS = 1500;

/**
 * One echo-deadline timer per `ViewerState` frame sent and not yet echoed,
 * oldest first. Server Echoes arrive in send order, so an own-client Echo
 * cancels the head; the next-oldest frame keeps its own deadline.
 */
type ViewerStateWait = { timers: number[] };

function stopViewerStateWait(wait: ViewerStateWait): void {
  for (const timer of wait.timers) {
    window.clearTimeout(timer);
  }
  wait.timers.length = 0;
}

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
 * Session sync: WebSocket primary (Applied fanout), HTTP publish fallback, and
 * a 30 s meta sanity poll for other processes' writes.
 *
 * Presence and durable deltas (`ViewerState`) publish over WS while it is
 * open. POST /api/session/state is the socket-down / rejected / unechoed
 * fallback.
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
  const sendRef = useRef<WsSender | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const cursorRef = useRef<AppliedCursor>({
    serverSeq: lastAppliedRevision,
    commandId: lastAppliedCommandId,
  });
  const applyAgentSessionRef = useRef(applyAgentSession);
  applyAgentSessionRef.current = applyAgentSession;

  cursorRef.current = {
    serverSeq: Math.max(cursorRef.current.serverSeq, lastAppliedRevision),
    commandId: lastAppliedCommandId,
  };

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const viewerStateWaitRef = useRef<ViewerStateWait>({ timers: [] });

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

  const viewerSnapshot = (): ViewerSessionSnapshot => ({
    ...buildViewerSnapshot(),
    client_id: clientIdRef.current,
    label: "Host",
  });

  /** HTTP publish: the socket-down path, and the recovery when a WS publish is rejected or never echoed. */
  const publishOverHttp = useEffectEvent(async () => {
    const written = await postSessionState(projectPath, viewerSnapshot());
    cursorRef.current = advanceCursorIfNewer(cursorRef.current, written);
  });

  /** Stop waiting for the ViewerState echo and republish the latest snapshot over HTTP. */
  const fallBackToHttp = useEffectEvent(() => {
    stopViewerStateWait(viewerStateWaitRef.current);
    void publishOverHttp().catch(() => {
      // Transient: the next publishKey change or reconnect republishes.
    });
  });

  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    const viewerStateWait = viewerStateWaitRef.current;
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
            code?: string;
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
            msg.type === "Error" &&
            (msg.code === "invalid_viewer_state" ||
              msg.code === "viewer_state_failed")
          ) {
            fallBackToHttp();
            return;
          }
          if (
            (msg.type === "Snapshot" ||
              msg.type === "Applied" ||
              msg.type === "Echo") &&
            msg.snapshot
          ) {
            const snap = msg.snapshot;
            if (
              msg.type === "Echo" &&
              msg.command?.type === "ViewerState" &&
              msg.command.client_id === clientIdRef.current
            ) {
              const oldest = viewerStateWaitRef.current.timers.shift();
              if (oldest !== undefined) {
                window.clearTimeout(oldest);
              }
            }
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
        if (cancelled || socket !== thisSocket) {
          return;
        }
        sendRef.current = null;
        // Unechoed ViewerState frames are not lost: setWsReady(false) below
        // re-runs the debounced publish effect (wsReady is in its deps), which
        // republishes the latest snapshot over HTTP since sendRef is now null.
        stopViewerStateWait(viewerStateWait);
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
      if (socket) {
        // A late close or open from this socket must not touch the next run's state.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      sendRef.current = null;
      stopViewerStateWait(viewerStateWait);
      setWsReady(false);
      useRecordHostStore.getState().resetConnection();
    };
  }, [projectPath, enabled, applyRemote]);

  const sendPresence = useCallback((frame: Record<string, unknown>) => {
    sendRef.current?.(frame);
  }, []);
  usePresencePublisher(wsReady ? sendPresence : null, "Host");

  // The sanity poll catches session commands written by another process
  // (stdio MCP, `podcast session` / `podcast play`).
  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadSessionMeta(projectPath),
    async (meta) => {
      if (sessionPollAlreadyApplied(meta.server_seq, cursorRef.current)) {
        return;
      }
      const state = await loadSessionState(projectPath);
      if (state) {
        applyRemote(state);
      }
    },
  );

  /**
   * Durable viewer state: one WS `ViewerState` frame while live, else HTTP.
   * The server's own-client Echo advances the cursor (onmessage) and ends the
   * wait; a rejection or no Echo within VIEWER_STATE_ECHO_TIMEOUT_MS of the oldest unechoed
   * send (half-open socket, dropped frame) republishes over HTTP. Each frame has its own
   * deadline: later sends do not extend the oldest one, and an Echo for the oldest hands
   * the deadline to the next-oldest frame's own send time.
   */
  const publish = useEffectEvent(async () => {
    if (
      sendRef.current?.({ type: "ViewerState", snapshot: viewerSnapshot() })
    ) {
      // Each frame gets its own deadline; fallBackToHttp clears the rest.
      viewerStateWaitRef.current.timers.push(
        window.setTimeout(() => fallBackToHttp(), VIEWER_STATE_ECHO_TIMEOUT_MS),
      );
      return;
    }
    await publishOverHttp();
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
            await publish();
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
    // wsReady: a (re)connect republishes over the new socket; a drop republishes
    // over HTTP. onclose relies on this to recover unechoed ViewerState frames.
  }, [projectPath, suppressPublish, publishKey, enabled, wsReady]);

  useEffect(() => {
    if (!enabled || !projectPath || suppressPublish || !isPlaying || wsReady) {
      return;
    }
    let cancelled = false;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          if (!cancelled) {
            await publish();
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
