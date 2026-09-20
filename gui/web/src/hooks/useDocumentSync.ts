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
import type { ProjectView } from "../types/project";
import { documentClientId } from "../utils/documentClient";

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
 * Document-plane WS: merge Applied snapshots/patches into the store.
 * Own-echo HTTP applies are skipped. useProjectPoll remains a safety net.
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

    const connect = () => {
      if (closed) {
        return;
      }
      ws = new WebSocket(documentWsUrl(projectPath));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as DocumentSnapshotMsg;
          if (msg.type === "Echo") {
            return;
          }
          if (msg.type !== "Applied" && msg.type !== "Snapshot") {
            return;
          }
          const snap = msg.snapshot;
          if (!snap) {
            return;
          }
          if (
            !shouldApplyDocumentEvent({
              type: msg.type,
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
      ws.onclose = () => {
        if (!closed) {
          retry = setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) {
        clearTimeout(retry);
      }
      ws?.close();
    };
  }, [projectPath, enabled]);
}
