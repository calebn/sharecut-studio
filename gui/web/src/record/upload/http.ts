import { apiFetch, recordProjectKey } from "../../api/http";
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
  const key = recordProjectKey(token);
  return {
    async status(signal) {
      const res = await apiFetch(
        key,
        { guest: "/upload" },
        { headers: headers(participantId, lease), signal },
      );
      return res.json() as Promise<RecordUploadStatus>;
    },
    async put(args) {
      const q = recordUploadSearchParams(args);
      const res = await apiFetch(
        key,
        { guest: `/upload?${q}` },
        {
          method: "POST",
          headers: headers(participantId, lease),
          body: copyUploadBody(args.data),
          signal: args.signal,
        },
      );
      return res.json() as Promise<RecordUploadAck>;
    },
    async revokeRoomTone(signal) {
      const q = new URLSearchParams({ kind: "room_tone" });
      await apiFetch(
        key,
        { guest: `/upload?${q}` },
        { method: "DELETE", headers: headers(participantId, lease), signal },
      );
    },
  };
}
