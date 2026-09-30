import { useEffect } from "react";
import {
  applyDocumentSnapshot,
  refreshDocumentDisplay,
} from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import { finishDocumentDraft } from "../document/pendingDrafts";
import type { DocumentSnapshot } from "../document/projectPatch";
import { getSessionToken } from "../sessionAuth";
import { requestHostDrainLazy } from "../state/requestDrainLazy";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { detachSocket } from "../sync/detachSocket";
import { enqueueInbound } from "../sync/inboundQueue";
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
  command?: { client_id?: string; command_id?: string };
  snapshot?: DocumentSnapshot;
};

/**
 * Document-plane WS (server→client only): merge Applied snapshots/patches into the store.
 * Own-client HTTP Applied at the current seq is skipped. useProjectPoll only refetches
 * writes this socket did not deliver (see noteDocumentFile).
 * A 4403 close (grant revoked by the post-accept authz recheck) is terminal: the session
 * token is read once per page, so reconnecting cannot succeed until reload. A refused
 * handshake closes before accept, which the browser reports as 1006, so it keeps retrying.
 * The offline-queue drain timer also runs on the 30 s sanity cadence (sanity net; other
 * processes' writes arrive over the socket via the server's cross-process watcher, #695);
 * a dropped socket resyncs from the hello Snapshot on reconnect, not a poll.
 * `commands/trackMix.ts` sizes `QUEUED_SHOWN_MS` from this cadence; keep them in step.
 */
export function useDocumentSync(
  projectPath: string,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled || !projectPath) {
      return;
    }
    const scope = activateDocumentScope(projectPath);
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
        let msg: DocumentSnapshotMsg;
        try {
          msg = JSON.parse(ev.data as string) as DocumentSnapshotMsg;
        } catch {
          return; // ignore malformed
        }
        if (msg.type !== "Applied" && msg.type !== "Snapshot") {
          return;
        }
        const snap = msg.snapshot;
        if (!snap) {
          return;
        }
        // Parsed at receipt like the session and guest hooks; the seq/file
        // bookkeeping and the apply run in order from the per-frame queue.
        enqueueInbound(() => {
          if (closed || !isCurrentDocumentScope(scope)) {
            return;
          }
          try {
            if (msg.command?.command_id)
              finishDocumentDraft(msg.command.command_id);
            applyDocumentSnapshot(snap, { scope });
            if (msg.command?.command_id) refreshDocumentDisplay();
          } catch {
            // An apply error drops this frame only, as it did before queuing.
          }
        });
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
    const drainTimer = window.setInterval(drain, SANITY_POLL_MS);
    return () => {
      closed = true;
      window.removeEventListener("online", onOnline);
      window.clearInterval(drainTimer);
      if (retry) {
        clearTimeout(retry);
      }
      if (ws) {
        detachSocket(ws);
      }
    };
  }, [projectPath, enabled]);
}
