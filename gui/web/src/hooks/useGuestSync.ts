import { useCallback, useEffect, useRef, useState } from "react";
import { loadProjectMeta } from "../api";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import {
  currentDocumentSeq,
  pollSnapshotAlreadyApplied,
} from "../document/cursor";
import type { DocumentSnapshot } from "../document/projectPatch";
import { applyServerClock } from "../presence/clock";
import {
  handlePresenceWsFrame,
  type PresenceCarryingFrame,
} from "../presence/presenceFrames";
import { usePresencePublisher } from "../presence/usePresencePublisher";
import {
  mergeSessionAppliedDelta,
  type SessionAppliedDelta,
  sessionAppliedHasGap,
  withAgentAppliedAuthority,
} from "../session/appliedDelta";
import { newClientId } from "../session/clientId";
import { createRosterRequester } from "../session/rosterRequest";
import { bindWsSender, type WsSender } from "../session/wsSend";
import { shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { mergeOfflineSnapshot } from "../state/offlineStore";
import { requestGuestDrainLazy } from "../state/requestDrainLazy";
import { detachSocket } from "../sync/detachSocket";
import { enqueueInbound } from "../sync/inboundQueue";
import type { ProjectView, TimelineComment } from "../types/project";
import type { SessionState } from "../types/session";
import { sessionDisplayName } from "../utils/commentAuthor";
import { createFallbackPoll } from "../utils/fallbackPoll";
import {
  type GuestProgressEvent,
  guestProgressToJob,
} from "../utils/guestProgress";

function guestWsUrl(token: string, clientId: string, name: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ client_id: clientId, name });
  return `${proto}://${window.location.host}/api/review/${encodeURIComponent(token)}/daw/ws?${q.toString()}`;
}

type GuestMsg = PresenceCarryingFrame & {
  type?: string;
  plane?: string;
  server_seq?: number;
  client_id?: string;
  prev_seq?: number;
  command?: {
    role?: string;
    type?: string;
    client_id?: string;
    command_id?: string;
  };
  snapshot?: SessionAppliedDelta & {
    server_seq?: number;
    comments?: TimelineComment[];
    project?: ProjectView;
  };
};

/**
 * Socket-down-only fallback: until the guest socket first opens and while it
 * is down this poll is the guest's only feed, so it stays fast. It is
 * deliberately not on `SANITY_POLL_MS`; while the socket is live the guest
 * runs `useProjectPoll` on the 30 s sanity cadence instead (#662).
 */
const FALLBACK_POLL_MS = 1500;

/**
 * Guest dual-plane WS: session + document fanout; guests may send Presence frames.
 * Until the socket first opens and whenever it is down, an HTTP project poll keeps
 * document state fresh.
 * Returns whether the guest socket is currently open, so useGuestSyncAndProjectPoll
 * can run useProjectPoll only while it is live (useGuestSync polls on its own while
 * it is down), giving a guest one project poll at a time (#657).
 */
export function useGuestSync(
  projectPath: string,
  applyAgentSession: (state: SessionState) => void,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): boolean {
  const projectEpoch = useDawStore((state) => state.projectEpoch);
  const applyRef = useRef(applyAgentSession);
  applyRef.current = applyAgentSession;
  const wsOpenRef = useRef(false);
  const connectIdRef = useRef(newClientId());
  const clientIdRef = useRef(connectIdRef.current);
  const pendingAgentRecoveryRef = useRef<GuestMsg | null>(null);
  const sendRef = useRef<WsSender | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const guestName = sessionDisplayName("guest");

  useEffect(() => {
    const token = shareTokenFromKey(projectPath);
    if (!enabled || !token) {
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const rosterRequester = createRosterRequester((frame) =>
      sendRef.current?.(frame),
    );
    const scope = activateDocumentScope(projectPath);
    pendingAgentRecoveryRef.current = null;
    wsOpenRef.current = false;

    const pollProject = () => {
      if (wsOpenRef.current || closed) {
        return;
      }
      void loadProjectMeta(projectPath)
        .then(async (meta) => {
          if (wsOpenRef.current || closed) {
            return;
          }
          if (
            pollSnapshotAlreadyApplied(meta) ||
            ((meta.server_seq ?? 0) > 0 &&
              (meta.server_seq ?? 0) < currentDocumentSeq())
          )
            return;
          const snapshot = await loadDocumentState(projectPath);
          if (wsOpenRef.current || closed || !isCurrentDocumentScope(scope))
            return;
          const next = applyDocumentSnapshot(snapshot, { scope });
          if (next) {
            void mergeOfflineSnapshot(token, { project: next });
          }
        })
        .catch(() => undefined);
    };

    const fallbackPoll = createFallbackPoll(pollProject, FALLBACK_POLL_MS);
    const startPoll = ({ immediate = true }: { immediate?: boolean } = {}) => {
      if (closed) {
        return;
      }
      fallbackPoll.start({ immediate });
    };
    const stopPoll = () => fallbackPoll.stop();

    const connect = () => {
      if (closed) {
        return;
      }
      ws = new WebSocket(
        guestWsUrl(token, connectIdRef.current, sessionDisplayName("guest")),
      );
      const thisSocket = ws;
      let retired = false;
      let sessionSnapshot: SessionState | null = null;
      let sessionResyncing = false;
      const current = () =>
        !closed &&
        !retired &&
        ws === thisSocket &&
        isCurrentDocumentScope(scope);
      ws.onopen = () => {
        if (!current()) return;
        wsOpenRef.current = true;
        const sock = ws;
        sendRef.current = bindWsSender(sock);
        setWsReady(true);
        stopPoll();
        requestGuestDrainLazy(token);
      };
      /**
       * Presence, progress and Applied/Snapshot handling for both planes.
       * Runs from the per-frame inbound queue; the clock sample and the
       * client-id handoff above already happened at receipt.
       */
      const handleGuestFrame = (msg: GuestMsg) => {
        if (!current()) {
          return;
        }
        if (handlePresenceWsFrame(msg, rosterRequester)) {
          return;
        }
        if (msg.plane === "progress" || msg.type === "progress") {
          const job = guestProgressToJob(
            msg as GuestProgressEvent,
            useDawStore.getState().activityJob,
          );
          useDawStore.getState().setActivityJob(job);
          return;
        }
        if (msg.type !== "Applied" && msg.type !== "Snapshot") {
          return;
        }
        const snap = msg.snapshot;
        if (!snap) {
          return;
        }
        if (msg.plane === "session") {
          const seq = Number(snap.server_seq ?? msg.server_seq ?? 0);
          if (msg.type === "Snapshot") {
            const full = snap as SessionState;
            sessionSnapshot = full;
            sessionResyncing = false;
            const pendingAgent = pendingAgentRecoveryRef.current;
            const targetSeq = Number(
              pendingAgent?.server_seq ??
                pendingAgent?.snapshot?.server_seq ??
                0,
            );
            if (pendingAgent && full.server_seq < targetSeq) {
              sessionResyncing = true;
              thisSocket.close(3000, "session snapshot behind gap");
              return;
            }
            const recovered = pendingAgent?.snapshot
              ? withAgentAppliedAuthority(
                  full,
                  pendingAgent.snapshot,
                  pendingAgent.command,
                )
              : full;
            pendingAgentRecoveryRef.current = null;
            applyRef.current(recovered);
            return;
          }
          if (msg.type !== "Applied") return;
          if (
            sessionAppliedHasGap(
              sessionSnapshot?.server_seq ?? null,
              msg.prev_seq,
              seq,
            )
          ) {
            if (!sessionResyncing && current()) {
              sessionResyncing = true;
              const role = msg.command?.role ?? snap.last_role ?? snap.origin;
              if (role === "agent" || snap.origin === "agent") {
                pendingAgentRecoveryRef.current = msg;
              }
              thisSocket.close(3000, "session sequence gap");
            }
            return;
          }
          if (!sessionSnapshot || seq < sessionSnapshot.server_seq) return;
          const merged = mergeSessionAppliedDelta(sessionSnapshot, snap);
          if (
            seq === sessionSnapshot.server_seq &&
            merged.last_command_id === sessionSnapshot.last_command_id
          ) {
            return;
          }
          sessionSnapshot = merged;
          applyRef.current(merged);
          return;
        }
        if (msg.plane === "document") {
          const next = applyDocumentSnapshot(snap as DocumentSnapshot, {
            scope,
          });
          if (next) void mergeOfflineSnapshot(token, { project: next });
        }
      };

      ws.onmessage = (ev) => {
        if (!current()) return;
        try {
          const msg = JSON.parse(ev.data as string) as GuestMsg & {
            server_time_ns?: number;
          };
          if (msg.server_time_ns || msg.snapshot?.server_time_ns) {
            applyServerClock(
              msg.server_time_ns ?? msg.snapshot?.server_time_ns,
            );
          }
          if (
            msg.plane === "session" &&
            typeof msg.client_id === "string" &&
            msg.client_id &&
            clientIdRef.current !== msg.client_id
          ) {
            clientIdRef.current = msg.client_id;
            useDawStore.getState().setLocalClientId(msg.client_id);
          }
          enqueueInbound(() => handleGuestFrame(msg), {
            coalesceKey:
              msg.type === "Presence" && Array.isArray(msg.clients)
                ? "guest:presence"
                : undefined,
          });
        } catch {
          // ignore malformed
        }
      };
      ws.onclose = () => {
        if (!current()) {
          return;
        }
        retired = true;
        wsOpenRef.current = false;
        sendRef.current = null;
        setWsReady(false);
        startPoll();
        if (!closed) {
          retry = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => {
        if (ws === thisSocket) {
          ws?.close();
        }
      };
    };
    connect();
    // Until the socket first opens (onopen stops it), cover the handshake with the
    // fallback poll; no immediate tick, bootstrap just loaded the project (#657).
    startPoll({ immediate: false });
    const onOnline = () => requestGuestDrainLazy(token);
    window.addEventListener("online", onOnline);
    return () => {
      closed = true;
      window.removeEventListener("online", onOnline);
      stopPoll();
      if (retry) {
        clearTimeout(retry);
      }
      if (ws) {
        detachSocket(ws);
      }
      wsOpenRef.current = false;
      sendRef.current = null;
      rosterRequester.dispose();
      setWsReady(false);
    };
  }, [projectPath, enabled, projectEpoch]);

  const sendPresence = useCallback((frame: Record<string, unknown>) => {
    sendRef.current?.(frame);
  }, []);
  usePresencePublisher(wsReady ? sendPresence : null, guestName);
  return wsReady;
}
