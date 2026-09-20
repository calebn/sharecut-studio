import { useCallback, useEffect, useRef, useState } from "react";
import { loadProject, loadProjectMeta } from "../api";
import {
  applyDocumentSnapshot,
  applyDocumentSnapshotWithResync,
} from "../document/applyDocumentUpdate";
import {
  currentDocumentSeq,
  eventServerSeq,
  noteDocumentSeq,
  resetDocumentSeq,
  shouldApplyDocumentEvent,
  shouldApplyPollSnapshot,
} from "../document/cursor";
import type { DocumentSnapshot } from "../document/projectPatch";
import { applyServerClock } from "../presence/clock";
import { usePresencePublisher } from "../presence/usePresencePublisher";
import { newClientId } from "../session/clientId";
import { bindWsSender } from "../session/wsSend";
import { shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { mergeOfflineSnapshot } from "../state/offlineStore";
import type { ProjectView, TimelineComment } from "../types/project";
import type { SessionState } from "../types/session";
import { loadCommentAuthor } from "../utils/commentAuthor";
import {
  type GuestProgressEvent,
  guestProgressToJob,
} from "../utils/guestProgress";

function guestDisplayName(): string {
  const raw = loadCommentAuthor();
  return raw === "viewer" ? "Guest" : raw;
}

function guestWsUrl(token: string, clientId: string, name: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ client_id: clientId, name });
  return `${proto}://${window.location.host}/api/review/${encodeURIComponent(token)}/daw/ws?${q.toString()}`;
}

type GuestMsg = {
  type?: string;
  plane?: string;
  server_seq?: number;
  client_id?: string;
  clients?: SessionState["clients"];
  snapshot?: SessionState & {
    server_seq?: number;
    comments?: TimelineComment[];
    project?: ProjectView;
  };
};

const FALLBACK_POLL_MS = 1500;

/**
 * Guest dual-plane WS: session + document fanout; guests may send Presence frames.
 * When the socket is down, HTTP project poll keeps document state fresh.
 * useProjectPoll remains an additional mtime safety net.
 */
export function useGuestSync(
  projectPath: string,
  applyAgentSession: (state: SessionState) => void,
  _project: ProjectView | null,
  _setProject: (project: ProjectView) => void,
  setSessionClients: (clients: NonNullable<SessionState["clients"]>) => void,
  enabled = true,
): void {
  const applyRef = useRef(applyAgentSession);
  applyRef.current = applyAgentSession;
  const setClientsRef = useRef(setSessionClients);
  setClientsRef.current = setSessionClients;
  const sessionSeqRef = useRef(0);
  const wsOpenRef = useRef(false);
  const connectIdRef = useRef(newClientId());
  const clientIdRef = useRef(connectIdRef.current);
  const sendRef = useRef<((frame: Record<string, unknown>) => void) | null>(
    null,
  );
  const [wsReady, setWsReady] = useState(false);
  const guestName = guestDisplayName();

  useEffect(() => {
    const token = shareTokenFromKey(projectPath);
    if (!enabled || !token) {
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    resetDocumentSeq();
    sessionSeqRef.current = 0;
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
          const metaSeq = meta.server_seq ?? 0;
          if (!shouldApplyPollSnapshot(metaSeq, currentDocumentSeq())) {
            return;
          }
          const proj = await loadProject(projectPath);
          if (wsOpenRef.current || closed) {
            return;
          }
          if (!shouldApplyPollSnapshot(metaSeq, currentDocumentSeq())) {
            return;
          }
          const next = applyDocumentSnapshot(
            { project: proj, server_seq: metaSeq },
            { force: true },
          );
          if (next) {
            void mergeOfflineSnapshot(token, { project: next });
          }
        })
        .catch(() => undefined);
    };

    const startPoll = () => {
      if (pollId != null || closed) {
        return;
      }
      pollId = setInterval(pollProject, FALLBACK_POLL_MS);
      pollProject();
    };

    const stopPoll = () => {
      if (pollId != null) {
        clearInterval(pollId);
        pollId = null;
      }
    };

    const connect = () => {
      if (closed) {
        return;
      }
      ws = new WebSocket(
        guestWsUrl(token, connectIdRef.current, guestDisplayName()),
      );
      ws.onopen = () => {
        wsOpenRef.current = true;
        const sock = ws;
        sendRef.current = bindWsSender(sock);
        setWsReady(true);
        stopPoll();
        void import("../state/drainOfflineQueue").then(
          ({ drainOfflineQueue }) => drainOfflineQueue(token),
        );
      };
      ws.onmessage = (ev) => {
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
          if (msg.type === "Presence" && Array.isArray(msg.clients)) {
            setClientsRef.current(msg.clients);
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
            if (seq > 0 && seq < sessionSeqRef.current) {
              return;
            }
            if (seq > 0) {
              sessionSeqRef.current = seq;
            }
            if (Array.isArray(snap.clients)) {
              setClientsRef.current(snap.clients);
            }
            applyRef.current(snap as SessionState);
            return;
          }
          if (msg.plane === "document") {
            const seq = Number(snap.server_seq ?? msg.server_seq ?? 0);
            if (
              !shouldApplyDocumentEvent({
                type: msg.type,
                server_seq: msg.server_seq,
                snapshot: snap as DocumentSnapshot,
                command: (msg as { command?: { client_id?: string } }).command,
              })
            ) {
              noteDocumentSeq(eventServerSeq(msg));
              return;
            }
            const cmdClientId = (msg as { command?: { client_id?: string } })
              .command?.client_id;
            if ((snap as DocumentSnapshot).resync) {
              void applyDocumentSnapshotWithResync(
                snap as DocumentSnapshot,
                () => loadProject(projectPath),
                { commandClientId: cmdClientId },
              ).then((next) => {
                if (next) {
                  void mergeOfflineSnapshot(token, { project: next });
                } else if (seq > 0) {
                  noteDocumentSeq(seq);
                }
              });
              return;
            }
            const next = applyDocumentSnapshot(snap as DocumentSnapshot, {
              commandClientId: cmdClientId,
            });
            if (next) {
              void mergeOfflineSnapshot(token, { project: next });
            } else if (seq > 0) {
              noteDocumentSeq(seq);
            }
            return;
          }
        } catch {
          // ignore malformed
        }
      };
      const thisSocket = ws;
      ws.onclose = () => {
        if (ws !== thisSocket) {
          return;
        }
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
    const onOnline = () => {
      void import("../state/drainOfflineQueue").then(({ drainOfflineQueue }) =>
        drainOfflineQueue(token),
      );
    };
    window.addEventListener("online", onOnline);
    return () => {
      closed = true;
      window.removeEventListener("online", onOnline);
      stopPoll();
      if (retry) {
        clearTimeout(retry);
      }
      ws?.close();
      sendRef.current = null;
      setWsReady(false);
    };
  }, [projectPath, enabled]);

  const sendPresence = useCallback((frame: Record<string, unknown>) => {
    sendRef.current?.(frame);
  }, []);
  usePresencePublisher(wsReady ? sendPresence : null, guestName);
}
