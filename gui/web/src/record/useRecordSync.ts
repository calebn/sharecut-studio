import { useCallback, useEffect, useRef, useState } from "react";
import { applyServerClock } from "../presence/clock";
import {
  clearRecordParticipant,
  loadRecordParticipant,
  saveRecordParticipant,
} from "../services/offlineQueue/offlineStore";
import { newClientId } from "../session/clientId";
import type { WsSender } from "../session/wsSend";
import { openPlaneSocket, type PlaneSocketContext } from "../sync/planeSocket";
import { isTerminalWsClose } from "../utils/wsClose";
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

/** A lease or identity hiccup the server expects the client to retry almost at once. */
const RECORD_QUICK_RETRY_MS = 250;

type RecordMsg = {
  server_time_ns?: number;
  type?: string;
  plane?: string;
  code?: string;
  detail?: string;
  participant_id?: string;
  lease?: string;
  snapshot?: RecordSnapshot;
};

/** Guest was removed (or forbidden before joining); GuestRoomApp shows "Recording access ended". */
export const RECORD_ACCESS_REMOVED = "access_removed";
/** Removed participant's invite link is closed to new identities; GuestRoomApp shows "Invite link closed". */
export const RECORD_INVITE_CLOSED = "invite_closed";

/** Record errors after which the hook stops reconnecting and GuestRoomApp shows an ended screen. */
export const RECORD_ACCESS_ENDED_REASONS = [
  RECORD_ACCESS_REMOVED,
  RECORD_INVITE_CLOSED,
] as const;
export type RecordAccessEndedReason =
  (typeof RECORD_ACCESS_ENDED_REASONS)[number];

export function isRecordAccessEnded(
  error: string | null,
): error is RecordAccessEndedReason {
  return (RECORD_ACCESS_ENDED_REASONS as readonly string[]).includes(
    error ?? "",
  );
}

export const RECORD_ROOM_FULL = "room_full";

const RECORD_SYNC_ERROR_COPY = new Map<string, string>([
  ["forbidden", "The host's room doesn't allow that action."],
  ["invalid_state", "That isn't possible in the room's current state."],
  ["rate_limited", "Too many requests. Wait a moment and try again."],
  ["join_first", "Still joining the room. Try again in a moment."],
  ["malformed", "The room sent a message this page couldn't read."],
]);
export const RECORD_SYNC_ERROR_FALLBACK_COPY =
  "The record room reported a problem.";

function isTerminalRecordError(error: string): boolean {
  return error === RECORD_ROOM_FULL || isRecordAccessEnded(error);
}

/** A terminal error keeps its screen: a later non-terminal code or a dismiss cannot replace it. */
function keepTerminalRecordError(
  current: string | null,
  next: string | null,
): string | null {
  return current !== null && isTerminalRecordError(current) ? current : next;
}

/** Guest-facing copy for a non-terminal record error; null when none applies or a terminal screen owns it. */
export function recordSyncErrorCopy(error: string | null): string | null {
  if (error === null || isTerminalRecordError(error)) {
    return null;
  }
  return RECORD_SYNC_ERROR_COPY.get(error) ?? RECORD_SYNC_ERROR_FALLBACK_COPY;
}

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
  const sendRef = useRef<WsSender | null>(null);
  const clientIdRef = useRef(newClientId());
  const nameRef = useRef(displayName);
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
    let heartbeat: number | null = null;
    let joined = false;
    let accessEnded = false;
    let cached: Awaited<ReturnType<typeof loadRecordParticipant>>;
    const endAccess = (
      reason: RecordAccessEndedReason,
      ctx?: PlaneSocketContext,
    ) => {
      accessEnded = true;
      setError(reason);
      ctx?.close();
    };
    const stopHeartbeat = () => {
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const socket = openPlaneSocket<RecordMsg>({
      url: () => recordWsUrl(token, clientIdRef.current, nameRef.current),
      prepare: async () => {
        cached = skipLeaseRef.current
          ? undefined
          : await loadRecordParticipant(token);
        joined = false;
        return !accessEnded;
      },
      onOpen: (ctx) => {
        sendRef.current = ctx.send;
        setConnected(true);
        setError(null);
        const payload: Record<string, unknown> = {
          display_name: nameRef.current || "Guest",
        };
        if (cached?.participant_id && cached.lease) {
          payload.participant_id = cached.participant_id;
          payload.lease = cached.lease;
        }
        ctx.send({
          type: "Record",
          command_type: "Join",
          payload,
          client_seq: nextRecordClientSeq(token),
        });
        stopHeartbeat();
        heartbeat = window.setInterval(() => {
          sendRef.current?.({
            type: "Record",
            command_type: "Heartbeat",
            payload: {},
            client_seq: nextRecordClientSeq(token),
          });
        }, 5000);
      },
      onReceive: (msg) => applyServerClock(msg.snapshot?.server_time_ns),
      onMalformed: () =>
        setError((current) => keepTerminalRecordError(current, "malformed")),
      fallback: {
        immediate: true,
        handle: (msg, ctx) => {
          if (isRecordSignal(msg)) {
            emitRecordSignal(msg);
            return;
          }
          if (msg.type === "Error") {
            if (msg.code === "lease_in_use") {
              ctx.retryIn(RECORD_QUICK_RETRY_MS);
              ctx.close();
              return;
            }
            if (msg.code === "invalid_lease" && !joined) {
              skipLeaseRef.current = true;
              ctx.retryIn(RECORD_QUICK_RETRY_MS);
              void clearRecordParticipant(token).then(
                () => ctx.close(),
                () => ctx.close(),
              );
              return;
            }
            if (msg.code === RECORD_INVITE_CLOSED) {
              endAccess(RECORD_INVITE_CLOSED, ctx);
              return;
            }
            if (
              msg.code === "participant_removed" ||
              msg.code === "forbidden"
            ) {
              if (!joined) {
                endAccess(RECORD_ACCESS_REMOVED, ctx);
              } else {
                setError((current) =>
                  keepTerminalRecordError(current, "forbidden"),
                );
              }
              return;
            }
            const next = msg.code || msg.detail || "error";
            setError((current) => keepTerminalRecordError(current, next));
            return;
          }
          if (msg.type === "Echo" && msg.participant_id && msg.lease) {
            joined = true;
            ctx.markHealthy();
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
        },
      },
      onClose: (event) => {
        setConnected(false);
        sendRef.current = null;
        stopHeartbeat();
        if (isTerminalWsClose(event.code) && !accessEnded) {
          endAccess(RECORD_ACCESS_REMOVED);
        }
      },
      shouldReconnect: () => !accessEnded,
    });
    return () => {
      socket.stop();
      stopHeartbeat();
      setConnected(false);
      sendRef.current = null;
    };
  }, [token, enabled]);

  const clearError = useCallback(() => {
    setError((current) => keepTerminalRecordError(current, null));
  }, []);

  const me =
    snapshot?.participants.find((p) => p.participant_id === meId) ?? null;
  return { snapshot, me, send, error, clearError, connected, lease };
}
