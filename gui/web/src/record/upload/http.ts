import { recordApiBase } from "../../shareRoute";
import { readApiError } from "../../utils/apiError";
import { copyUploadBody, recordUploadSearchParams } from "./params";
import type {
  RecordUploadAck,
  RecordUploadStatus,
  RecordUploadTransport,
} from "./transport";

function headers(participantId: string, lease: string): HeadersInit {
  return {
    "X-Record-Participant": participantId,
    "X-Record-Lease": lease,
  };
}

export function guestRecordUploadTransport(
  token: string,
  participantId: string,
  lease: string,
): RecordUploadTransport {
  const base = recordApiBase(token);
  return {
    async status(signal) {
      const res = await fetch(`${base}/upload`, {
        headers: headers(participantId, lease),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
      return res.json() as Promise<RecordUploadStatus>;
    },
    async put(args) {
      const q = recordUploadSearchParams(args);
      const res = await fetch(`${base}/upload?${q.toString()}`, {
        method: "POST",
        headers: headers(participantId, lease),
        body: copyUploadBody(args.data),
        signal: args.signal,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
      return res.json() as Promise<RecordUploadAck>;
    },
    async revokeRoomTone(signal) {
      const q = new URLSearchParams({ kind: "room_tone" });
      const res = await fetch(`${base}/upload?${q.toString()}`, {
        method: "DELETE",
        headers: headers(participantId, lease),
        signal,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
    },
  };
}
