import { useCallback, useEffect, useRef, useState } from "react";
import { applyServerClock } from "../presence/clock";
import { newClientId } from "../session/clientId";
import { bindWsSender } from "../session/wsSend";
import {
  clearRecordParticipant,
  loadRecordParticipant,
  saveRecordParticipant,
} from "../state/offlineStore";
import { emitRecordSignal, isRecordSignal } from "./monitor/signalBus";
import type { RecordSnapshot } from "./types";

function recordWsUrl(token: string, clientId: string, name: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ client_id: clientId, name });
  return `${proto}://${window.location.host}/api/rec/${encodeURIComponent(token)}/ws?${q.toString()}`;
}

function seqStorageKey(token: string): string {
  return `record:${token}:client_seq`;
}

function nextRecordClientSeq(token: string): number {
  try {
    const parsed = Number.parseInt(
      sessionStorage.getItem(seqStorageKey(token)) || "0",
      10,
    );
    const next = (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) + 1;
    sessionStorage.setItem(seqStorageKey(token), String(next));
    return next;
  } catch {
    return Date.now();
  }
}

type RecordMsg = {
  type?: string;
  plane?: string;
  code?: string;
  detail?: string;
  participant_id?: string;
  lease?: string;
  snapshot?: RecordSnapshot;
};

export function useRecordSync(
  token: string,
  displayName: string,
  enabled = true,
) {
  const [snapshot, setSnapshot] = useState<RecordSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [lease, setLease] = useState<string | null>(null);
  const sendRef = useRef<((frame: Record<string, unknown>) => void) | null>(
    null,
  );
  const clientIdRef = useRef(newClientId());
  const nameRef = useRef(displayName);
  const retryMsRef = useRef(1000);
  const skipLeaseRef = useRef(false);
  nameRef.current = displayName;

  const send = useCallback(
    (
      commandType: string,
      payload: Record<string, unknown> = {},
      commandId?: string,
    ) => {
      const sender = sendRef.current;
      if (!sender) {
        return false;
      }
      const frame: Record<string, unknown> = {
        type: "Record",
        command_type: commandType,
        payload,
        client_seq: nextRecordClientSeq(token),
      };
      if (commandId) {
        frame.command_id = commandId;
      }
      sender(frame);
      return true;
    },
    [token],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let retry: number | null = null;
    let heartbeat: number | null = null;
    let socket: WebSocket | null = null;
    let joined = false;
    let accessEnded = false;

    const connect = async () => {
      if (cancelled) {
        return;
      }
      const cached = skipLeaseRef.current
        ? undefined
        : await loadRecordParticipant(token);
      if (cancelled || accessEnded) {
        return;
      }
      joined = false;
      socket = new WebSocket(
        recordWsUrl(token, clientIdRef.current, nameRef.current),
      );
      const thisSocket = socket;
      socket.onopen = () => {
        sendRef.current = bindWsSender(thisSocket);
        setConnected(true);
        setError(null);
        const payload: Record<string, unknown> = {
          display_name: nameRef.current || "Guest",
        };
        if (cached?.participant_id && cached.lease) {
          payload.participant_id = cached.participant_id;
          payload.lease = cached.lease;
        }
        sendRef.current?.({
          type: "Record",
          command_type: "Join",
          payload,
          client_seq: nextRecordClientSeq(token),
        });
        if (heartbeat !== null) {
          window.clearInterval(heartbeat);
        }
        heartbeat = window.setInterval(() => {
          sendRef.current?.({
            type: "Record",
            command_type: "Heartbeat",
            payload: {},
            client_seq: nextRecordClientSeq(token),
          });
        }, 5000);
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as RecordMsg;
          applyServerClock(msg.snapshot?.server_time_ns);
          if (isRecordSignal(msg)) {
            emitRecordSignal(msg);
            return;
          }
          if (msg.type === "Error") {
            if (msg.code === "lease_in_use") {
              retryMsRef.current = 250;
              thisSocket.close();
              return;
            }
            if (msg.code === "invalid_lease" && !joined) {
              skipLeaseRef.current = true;
              retryMsRef.current = 250;
              void clearRecordParticipant(token).then(
                () => thisSocket.close(),
                () => thisSocket.close(),
              );
              return;
            }
            if (msg.code === "invite_closed") {
              accessEnded = true;
              setError("invite_closed");
              thisSocket.close();
              return;
            }
            if (
              msg.code === "participant_removed" ||
              msg.code === "forbidden"
            ) {
              if (!joined) {
                accessEnded = true;
                setError("access_removed");
                thisSocket.close();
              } else {
                setError("forbidden");
              }
              return;
            }
            setError(msg.code || msg.detail || "error");
            return;
          }
          if (msg.type === "Echo" && msg.participant_id && msg.lease) {
            joined = true;
            skipLeaseRef.current = false;
            setMeId(msg.participant_id);
            setLease(msg.lease);
            void saveRecordParticipant(token, {
              participant_id: msg.participant_id,
              lease: msg.lease,
            });
          }
          if (msg.snapshot) {
            setSnapshot(msg.snapshot);
          }
        } catch {
          setError("malformed");
        }
      };
      socket.onclose = (event) => {
        setConnected(false);
        sendRef.current = null;
        if (heartbeat !== null) {
          window.clearInterval(heartbeat);
          heartbeat = null;
        }
        if (event.code === 4403) {
          accessEnded = true;
          setError("access_removed");
        }
        if (!cancelled && !accessEnded) {
          const delay = retryMsRef.current;
          retryMsRef.current = 1000;
          retry = window.setTimeout(() => void connect(), delay);
        }
      };
    };
    void connect();
    return () => {
      cancelled = true;
      if (retry !== null) {
        window.clearTimeout(retry);
      }
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
      }
      socket?.close();
    };
  }, [token, enabled]);

  const me =
    snapshot?.participants.find((p) => p.participant_id === meId) ?? null;
  return { snapshot, me, send, error, connected, lease };
}
