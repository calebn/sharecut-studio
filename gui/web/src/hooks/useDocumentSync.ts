import { useEffect } from "react";
import { loadProject } from "../api";
import {
  applyDocumentSnapshot,
  applyDocumentSnapshotWithResync,
} from "../document/applyDocumentUpdate";
import {
  eventServerSeq,
  noteDocumentSeq,
  resetDocumentSeq,
  shouldApplyDocumentEvent,
} from "../document/cursor";
import type { DocumentSnapshot } from "../document/projectPatch";
import { getSessionToken } from "../sessionAuth";
import { requestHostDrainLazy } from "../state/requestDrainLazy";
import type { ProjectView } from "../types/project";
import { documentClientId } from "../utils/documentClient";
import { isTerminalWsClose } from "../utils/wsClose";

function documentWsUrl(projectPath: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    path: projectPath,
    client_id: documentClientId(),
    role: "viewer",
    label: "DAW",
  });
  const tok = getSessionToken();
  if (tok) {
    q.set("token", tok);
  }
  return `${proto}://${window.location.host}/api/document/ws?${q.toString()}`;
}

type DocumentSnapshotMsg = {
  type?: string;
  server_seq?: number;
  command?: { client_id?: string };
  snapshot?: DocumentSnapshot;
};

/**
 * Document-plane WS (server→client only): merge Applied snapshots/patches into the store.
 * Own-client HTTP Applied at the current seq is skipped. useProjectPoll remains a safety net.
 * A 4403 close (grant revoked by the post-accept authz recheck) is terminal: the session
 * token is read once per page, so reconnecting cannot succeed until reload. A refused
 * handshake closes before accept, which the browser reports as 1006, so it keeps retrying.
 */
export function useDocumentSync(
  projectPath: string,
  _project: ProjectView | null,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    resetDocumentSeq();
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const drain = () => requestHostDrainLazy(projectPath);

    const connect = () => {
      if (closed) {
        return;
      }
      ws = new WebSocket(documentWsUrl(projectPath));
      ws.onopen = () => {
        drain();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as DocumentSnapshotMsg;
          if (msg.type !== "Applied" && msg.type !== "Snapshot") {
            return;
          }
          const snap = msg.snapshot;
          if (!snap) {
            return;
          }
          if (
            !shouldApplyDocumentEvent({
              server_seq: msg.server_seq,
              snapshot: snap,
              command: msg.command,
            })
          ) {
            noteDocumentSeq(eventServerSeq(msg));
            return;
          }
          if (snap.resync) {
            applyDocumentSnapshotWithResync(
              snap,
              () => loadProject(projectPath),
              {
                commandClientId: msg.command?.client_id,
              },
            ).catch(() => undefined);
          } else {
            applyDocumentSnapshot(snap, {
              commandClientId: msg.command?.client_id,
            });
          }
        } catch {
          // ignore malformed
        }
      };
      ws.onclose = (event) => {
        if (!closed && !isTerminalWsClose(event.code)) {
          retry = setTimeout(connect, 2000);
        }
      };
    };
    connect();
    const onOnline = () => drain();
    window.addEventListener("online", onOnline);
    const drainTimer = window.setInterval(drain, 10_000);
    return () => {
      closed = true;
      window.removeEventListener("online", onOnline);
      window.clearInterval(drainTimer);
      if (retry) {
        clearTimeout(retry);
      }
      ws?.close();
    };
  }, [projectPath, enabled]);
}
