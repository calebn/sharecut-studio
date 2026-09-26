import { hostFetch } from "../api/documentTransport";
import {
  copyUploadBody,
  recordUploadSearchParams,
} from "../record/upload/params";
import { isShareProjectKey } from "../shareMode";
import type {
  HostRecordRoom,
  HostShareRow,
  HostSharesResponse,
  ShareRole,
} from "../types/shares";
import { readApiError } from "../utils/apiError";

export async function listHostShares(
  projectPath: string,
): Promise<HostSharesResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/shares?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<HostSharesResponse>;
}

export async function createHostShare(
  projectPath: string,
  body: {
    role: ShareRole;
    with_mcp?: boolean;
    review_version_id?: string | null;
  },
): Promise<HostShareRow> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await hostFetch("/api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { share: HostShareRow };
  return data.share;
}

export async function revokeHostShare(
  projectPath: string,
  shareToken: string,
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/shares/${encodeURIComponent(shareToken)}/revoke`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
}

export async function createHostRecordRoom(
  projectPath: string,
  expiresAt?: string | null,
): Promise<HostRecordRoom> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await hostFetch("/api/shares/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      expires_at: expiresAt ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { room: HostRecordRoom };
  return data.room;
}

export async function loadHostRecordState(
  projectPath: string,
): Promise<import("../record/types").RecordSnapshot | null> {
  if (isShareProjectKey(projectPath)) {
    return null;
  }
  const res = await hostFetch(
    `/api/record/state?path=${encodeURIComponent(projectPath)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<import("../record/types").RecordSnapshot>;
}

export async function postHostRecordCommand(
  projectPath: string,
  commandType: string,
  payload: Record<string, unknown> = {},
): Promise<import("../record/types").RecordSnapshot> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Record transport is host-only");
  }
  const res = await hostFetch("/api/record/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      command_type: commandType,
      payload,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<import("../record/types").RecordSnapshot>;
}

export function hostRecordUploadTransport(
  projectPath: string,
): import("../record/upload/transport").RecordUploadTransport {
  return {
    async status(signal) {
      const res = await hostFetch(
        `/api/record/upload?path=${encodeURIComponent(projectPath)}`,
        { signal },
      );
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
      return res.json();
    },
    async put(args) {
      const q = recordUploadSearchParams({
        ...args,
        extra: { path: projectPath },
      });
      const res = await hostFetch(`/api/record/upload?${q.toString()}`, {
        method: "POST",
        body: copyUploadBody(args.data),
        signal: args.signal,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
      return res.json();
    },
    async revokeRoomTone(signal) {
      const q = new URLSearchParams({
        path: projectPath,
        kind: "room_tone",
      });
      const res = await hostFetch(`/api/record/upload?${q.toString()}`, {
        method: "DELETE",
        signal,
      });
      if (!res.ok) {
        throw new Error(await readApiError(res));
      }
    },
  };
}

export async function hostLandRecord(
  projectPath: string,
): Promise<{ clips: unknown[]; align_fallback?: boolean }> {
  const res = await hostFetch(
    `/api/record/land?path=${encodeURIComponent(projectPath)}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json();
}

export async function revokeHostRoom(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/shares/rooms/${encodeURIComponent(sessionId)}/revoke`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
}
