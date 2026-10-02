import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { loadSessionMeta, loadSessionState, postSessionState } from "../api";
import {
  applyDocumentSnapshot,
  refreshDocumentDisplay,
} from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  documentAuthority,
  isCurrentDocumentScope,
} from "../document/authorityState";
import { finishDocumentDraft } from "../document/pendingDrafts";
import type { DocumentSnapshot } from "../document/projectPatch";
import { applyServerClock } from "../presence/clock";
import {
  handlePresenceWsFrame,
  type PresenceCarryingFrame,
} from "../presence/presenceFrames";
import { usePresencePublisher } from "../presence/usePresencePublisher";
import { useRecordHostStore } from "../record/hostStore";
import { bindRecordHostSend } from "../record/hostWire";
import { emitRecordSignal, isRecordSignal } from "../record/monitor/signalBus";
import type { RecordSnapshot } from "../record/types";
import {
  mergeSessionAppliedDelta,
  type SessionAppliedDelta,
  sessionAppliedHasGap,
  withAgentAppliedAuthority,
} from "../session/appliedDelta";
import { newClientId } from "../session/clientId";
import {
  type AppliedCursor,
  advanceCursorIfNewer,
  baselineFromSnapshot,
  sessionPollAlreadyApplied,
  shouldApplyRemote,
  shouldHandleWsMessage,
} from "../session/dedupe";
import { createRosterRequester } from "../session/rosterRequest";
import { bindWsSender, type WsSender } from "../session/wsSend";
import { getSessionToken } from "../sessionAuth";
import { useDawStore } from "../state/dawStore";
import { requestHostDrainLazy } from "../state/requestDrainLazy";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { detachSocket } from "../sync/detachSocket";
import { hostReconnectDelay } from "../sync/hostReconnect";
import { enqueueInbound } from "../sync/inboundQueue";
import type { SessionState, ViewerSessionSnapshot } from "../types/session";
import { HOST_SESSION_LABEL } from "../utils/commentAuthor";
import { documentClientId } from "../utils/documentClient";
import { isTerminalWsClose } from "../utils/wsClose";
import { useFileMetaPoll } from "./useFileMetaPoll";

const PLAYHEAD_HEARTBEAT_MS = 200;
const DISCRETE_DEBOUNCE_MS = 50;

const VIEWER_STATE_ECHO_TIMEOUT_MS = 1500;

type ViewerStateWait = { timers: number[] };

function stopViewerStateWait(wait: ViewerStateWait): void {
  for (const timer of wait.timers) {
    window.clearTimeout(timer);
  }
  wait.timers.length = 0;
}

type SessionWireMsg = PresenceCarryingFrame & {
  type: string;
  code?: string;
  plane: "session";
  server_time_ns?: number;
  server_seq?: number;
  prev_seq?: number;
  snapshot?: SessionAppliedDelta;
  command?: {
    role?: string;
    type?: string;
    client_id?: string;
    command_id?: string;
  };
};

type DocumentWireMsg = {
  plane: "document";
  type: string;
  snapshot?: DocumentSnapshot;
  command?: { client_id?: string; command_id?: string };
};
type RecordWireMsg = {
  plane: "record";
  type: string;
  snapshot?: RecordSnapshot;
};
type HostWireMsg = SessionWireMsg | DocumentWireMsg | RecordWireMsg;

function wsUrl(projectPath: string, clientId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    path: projectPath,
    client_id: clientId,
    document_client_id: documentClientId(),
    role: "viewer",
    label: HOST_SESSION_LABEL,
  });
  const tok = getSessionToken();
  if (tok) {
    q.set("token", tok);
  }
  return `${proto}://${window.location.host}/api/host/ws?${q.toString()}`;
}

export function useHostSync(
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
  const projectEpoch = useDawStore((state) => state.projectEpoch);
  const clientIdRef = useRef(newClientId());
  const sendRef = useRef<WsSender | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const cursorRef = useRef<{ epoch: number; value: AppliedCursor }>({
    epoch: projectEpoch,
    value: { serverSeq: lastAppliedRevision, commandId: lastAppliedCommandId },
  });
  if (cursorRef.current.epoch !== projectEpoch) {
    cursorRef.current = {
      epoch: projectEpoch,
      value: { serverSeq: 0, commandId: null },
    };
  }
  const applyAgentSessionRef = useRef(applyAgentSession);
  applyAgentSessionRef.current = applyAgentSession;
  const remoteSessionRef = useRef<SessionState | null>(null);

  cursorRef.current.value = {
    serverSeq: Math.max(cursorRef.current.value.serverSeq, lastAppliedRevision),
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
  }, [enabled, projectEpoch]);

  const applyRemote = useCallback(
    (
      state: SessionState,
      commandType?: string | null,
      commandClientId?: string | null,
    ) => {
      const { apply, next } = shouldApplyRemote(
        state,
        cursorRef.current.value,
        {
          commandType,
          localPlaying: isPlayingRef.current,
          localClientId: clientIdRef.current,
          commandClientId,
        },
      );
      if (!apply) {
        cursorRef.current.value = {
          serverSeq: Math.max(
            next.serverSeq,
            cursorRef.current.value.serverSeq,
          ),
          commandId: next.commandId,
        };
        return;
      }
      cursorRef.current.value = next;
      applyAgentSessionRef.current(state);
    },
    [],
  );

  const viewerSnapshot = (): ViewerSessionSnapshot => ({
    ...buildViewerSnapshot(),
    client_id: clientIdRef.current,
    label: HOST_SESSION_LABEL,
  });

  const publishOverHttp = useEffectEvent(async () => {
    if (suppressPublish || !enabled || !projectPath) return;
    const scope = activateDocumentScope(projectPath);
    const written = await postSessionState(projectPath, viewerSnapshot());
    if (isCurrentDocumentScope(scope)) {
      const held = remoteSessionRef.current;
      if (!held || written.server_seq >= held.server_seq) {
        remoteSessionRef.current = written;
      }
      cursorRef.current.value = advanceCursorIfNewer(
        cursorRef.current.value,
        written,
      );
    }
  });

  const fallBackToHttp = useEffectEvent(() => {
    stopViewerStateWait(viewerStateWaitRef.current);
    void publishOverHttp().catch(() => {});
  });

  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    remoteSessionRef.current = null;
    const scope = activateDocumentScope(projectPath);
    const viewerStateWait = viewerStateWaitRef.current;
    let attempt = 0;
    const drain = () => requestHostDrainLazy(projectPath);
    let cancelled = false;
    let retry: number | null = null;
    let socket: WebSocket | null = null;
    let sessionResyncInFlight = false;
    let sessionResyncTargetSeq = 0;
    let pendingAgentResync: SessionWireMsg | null = null;
    let sessionResyncRetry: number | null = null;
    const rosterRequester = createRosterRequester((frame) =>
      sendRef.current?.(frame),
    );

    const requestSessionResync = (gap?: SessionWireMsg) => {
      if (gap) {
        sessionResyncTargetSeq = Math.max(
          sessionResyncTargetSeq,
          Number(gap.server_seq ?? gap.snapshot?.server_seq ?? 0),
          cursorRef.current.value.serverSeq,
        );
        const role =
          gap.command?.role ?? gap.snapshot?.last_role ?? gap.snapshot?.origin;
        if (role === "agent" || gap.snapshot?.origin === "agent") {
          pendingAgentResync = gap;
        }
      }
      if (sessionResyncInFlight || sessionResyncTargetSeq <= 0) return;
      sessionResyncInFlight = true;
      let retryBehindTarget = false;
      void loadSessionState(projectPath)
        .then((snapshot) => {
          if (!snapshot || cancelled || !isCurrentDocumentScope(scope)) return;
          sessionResyncTargetSeq = Math.max(
            sessionResyncTargetSeq,
            cursorRef.current.value.serverSeq,
          );
          if (snapshot.server_seq < sessionResyncTargetSeq) {
            retryBehindTarget = true;
            return;
          }
          const held = remoteSessionRef.current;
          if (
            snapshot.server_seq >= cursorRef.current.value.serverSeq &&
            (!held || snapshot.server_seq >= held.server_seq)
          ) {
            remoteSessionRef.current = snapshot;
          }
          if (snapshot.server_seq >= cursorRef.current.value.serverSeq) {
            const authority = pendingAgentResync;
            const state = authority?.snapshot
              ? withAgentAppliedAuthority(
                  snapshot,
                  authority.snapshot,
                  authority.command,
                )
              : snapshot;
            applyRemote(
              state,
              authority?.command?.type,
              authority?.command?.client_id ?? state.last_client_id,
            );
            sessionResyncTargetSeq = 0;
            pendingAgentResync = null;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          sessionResyncInFlight = false;
          if (retryBehindTarget && !cancelled) {
            sessionResyncRetry = window.setTimeout(() => {
              sessionResyncRetry = null;
              requestSessionResync();
            }, 100);
          }
        });
    };

    const handleSessionFrame = (msg: SessionWireMsg) => {
      if (cancelled || !isCurrentDocumentScope(scope)) {
        return;
      }
      if (handlePresenceWsFrame(msg, rosterRequester)) {
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
        const patch = msg.snapshot;
        if (msg.type === "Snapshot") {
          const snap = patch as SessionState;
          const held = remoteSessionRef.current;
          if (
            snap.server_seq >= cursorRef.current.value.serverSeq &&
            (!held || snap.server_seq >= held.server_seq)
          ) {
            remoteSessionRef.current = snap;
          }
          if (
            cursorRef.current.value.serverSeq === 0 &&
            remoteSessionRef.current === snap
          ) {
            const { apply, next } = baselineFromSnapshot(
              snap,
              cursorRef.current.value,
            );
            if (apply) applyAgentSessionRef.current(snap);
            cursorRef.current.value = next;
          }
          return;
        }

        const isDurableDelta =
          msg.type === "Applied" ||
          (msg.type === "Echo" && msg.prev_seq !== undefined);
        let snap = patch as SessionState;
        if (isDurableDelta) {
          const held = remoteSessionRef.current;
          const serverSeq = Number(msg.server_seq ?? patch.server_seq ?? 0);
          if (
            sessionAppliedHasGap(
              held?.server_seq ?? null,
              msg.prev_seq,
              serverSeq,
            )
          ) {
            requestSessionResync(msg);
            return;
          }
          if (!held || serverSeq < held.server_seq) return;
          snap = mergeSessionAppliedDelta(held, patch);
          remoteSessionRef.current = snap;
        } else {
          const full = patch as SessionState;
          const held = remoteSessionRef.current;
          if (
            full.server_seq >= cursorRef.current.value.serverSeq &&
            (!held || full.server_seq >= held.server_seq)
          ) {
            remoteSessionRef.current = full;
          }
          snap = remoteSessionRef.current ?? full;
        }
        if (
          shouldHandleWsMessage(
            { type: msg.type, command: msg.command, snapshot: snap },
            cursorRef.current.value,
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
          cursorRef.current.value = advanceCursorIfNewer(
            cursorRef.current.value,
            snap,
          );
        }
      }
    };

    const connect = () => {
      if (cancelled || !isCurrentDocumentScope(scope)) {
        return;
      }
      socket = new WebSocket(wsUrl(projectPath, clientIdRef.current));
      const thisSocket = socket;
      socket.onopen = () => {
        if (!current()) return;
        drain();
        sendRef.current = bindWsSender(thisSocket);
        bindRecordHostSend(sendRef.current);
        setWsReady(true);
        useRecordHostStore.getState().setConnected(true);
      };
      let retired = false;
      const initialized = new Set<"session" | "document">();
      const current = () =>
        !cancelled &&
        !retired &&
        socket === thisSocket &&
        isCurrentDocumentScope(scope);
      const noteInitialized = (plane: "session" | "document") => {
        initialized.add(plane);
        if (initialized.size === 2) attempt = 0;
      };
      socket.onmessage = (ev) => {
        if (!current()) return;
        let msg: HostWireMsg;
        try {
          msg = JSON.parse(ev.data as string) as HostWireMsg;
          if (!msg || typeof msg !== "object") return;
        } catch {
          return;
        }
        if (msg.plane === "session") {
          applyServerClock(msg.server_time_ns ?? msg.snapshot?.server_time_ns);
          if (
            msg.type === "Echo" &&
            msg.snapshot &&
            msg.command?.type === "ViewerState" &&
            msg.command.client_id === clientIdRef.current
          ) {
            const oldest = viewerStateWait.timers.shift();
            if (oldest !== undefined) window.clearTimeout(oldest);
          }
          enqueueInbound(
            () => {
              if (!current()) return;
              handleSessionFrame(msg);
              if (msg.type === "Snapshot" && msg.snapshot)
                noteInitialized("session");
            },
            {
              coalesceKey:
                msg.type === "Presence" && Array.isArray(msg.clients)
                  ? "host:presence"
                  : undefined,
            },
          );
        } else if (msg.plane === "document") {
          const snap = msg.snapshot;
          if (!snap || (msg.type !== "Snapshot" && msg.type !== "Applied"))
            return;
          enqueueInbound(() => {
            if (!current()) return;
            if (msg.command?.command_id)
              finishDocumentDraft(msg.command.command_id);
            applyDocumentSnapshot(snap, { scope });
            if (msg.command?.command_id) refreshDocumentDisplay();
            if (
              msg.type === "Snapshot" &&
              documentAuthority.phase.kind === "ready" &&
              !snap.resync
            )
              noteInitialized("document");
          });
        } else if (msg.plane === "record") {
          enqueueInbound(() => {
            if (!current()) return;
            if (isRecordSignal(msg)) emitRecordSignal(msg);
            else if (msg.snapshot) {
              const snapshot = msg.snapshot;
              flushSync(() =>
                useRecordHostStore.getState().setSnapshot(snapshot),
              );
            }
          });
        }
      };
      socket.onclose = (event) => {
        if (!current()) return;
        retired = true;
        sendRef.current = null;
        stopViewerStateWait(viewerStateWait);
        bindRecordHostSend(null);
        setWsReady(false);
        useRecordHostStore.getState().setConnected(false);
        if (!isTerminalWsClose(event.code)) {
          retry = window.setTimeout(connect, hostReconnectDelay(attempt++));
        }
      };
      socket.onerror = () => {
        if (socket === thisSocket) {
          socket?.close();
        }
      };
    };
    connect();
    const onOnline = () => drain();
    window.addEventListener("online", onOnline);
    const drainTimer = window.setInterval(drain, SANITY_POLL_MS);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(drainTimer);
      cancelled = true;
      if (retry != null) {
        window.clearTimeout(retry);
      }
      bindRecordHostSend(null);
      if (socket) {
        detachSocket(socket);
      }
      sendRef.current = null;
      rosterRequester.dispose();
      stopViewerStateWait(viewerStateWait);
      if (sessionResyncRetry != null) {
        window.clearTimeout(sessionResyncRetry);
      }
      setWsReady(false);
      useRecordHostStore.getState().resetConnection();
    };
  }, [projectPath, enabled, projectEpoch, applyRemote]);

  const sendPresence = useCallback((frame: Record<string, unknown>) => {
    sendRef.current?.(frame);
  }, []);
  usePresencePublisher(wsReady ? sendPresence : null, HOST_SESSION_LABEL);
  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadSessionMeta(projectPath),
    async (meta) => {
      const scope = activateDocumentScope(projectPath);
      if (sessionPollAlreadyApplied(meta.server_seq, cursorRef.current.value)) {
        return;
      }
      const state = await loadSessionState(projectPath);
      if (state && isCurrentDocumentScope(scope)) {
        remoteSessionRef.current = state;
        applyRemote(state);
      }
    },
    SANITY_POLL_MS,
    `${projectPath}\0${projectEpoch}`,
  );

  const publish = useEffectEvent(async () => {
    if (suppressPublish || !enabled || !projectPath) return;
    if (
      sendRef.current?.({ type: "ViewerState", snapshot: viewerSnapshot() })
    ) {
      viewerStateWaitRef.current.timers.push(
        window.setTimeout(() => fallBackToHttp(), VIEWER_STATE_ECHO_TIMEOUT_MS),
      );
      return;
    }
    await publishOverHttp();
  });

  useEffect(() => {
    if (!enabled || !projectPath || suppressPublish) {
      stopViewerStateWait(viewerStateWaitRef.current);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!cancelled) {
            await publish();
          }
        } catch {}
      })();
    }, DISCRETE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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
        } catch {}
      })();
    }, PLAYHEAD_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectPath, suppressPublish, isPlaying, enabled, wsReady]);
}
