import { hostFetch } from "../api/documentTransport";
import type { RecordSessionSummary, RecordSnapshot } from "../record/types";
import {
  copyUploadBody,
  recordUploadSearchParams,
} from "../record/upload/params";
import type { RecordUploadTransport } from "../record/upload/transport";
import { isShareProjectKey } from "../shareMode";
import type {
  HostRecordRoom,
  HostShareRow,
  HostSharesResponse,
  ShareRole,
} from "../types/shares";
import { readApiFailure } from "../utils/apiError";
import { apiFetch, HOST_KEY } from "./http";

export async function listHostShares(
  projectPath: string,
): Promise<HostSharesResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await apiFetch(HOST_KEY, {
    host: `/api/shares?path=${encodeURIComponent(projectPath)}`,
  });
  return res.json() as Promise<HostSharesResponse>;
}

export async function createHostShare(
  projectPath: string,
  body: {
    role: ShareRole;
    with_mcp?: boolean;
    /** Play the current version for good instead of following the latest. */
    freeze?: boolean;
    review_version_id?: string | null;
  },
): Promise<HostShareRow> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/shares" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, ...body }),
    },
  );
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
  await apiFetch(
    HOST_KEY,
    { host: `/api/shares/${encodeURIComponent(shareToken)}/revoke` },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
}

export async function createHostRecordRoom(
  projectPath: string,
  expiresAt?: string | null,
): Promise<HostRecordRoom> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/shares/record" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        expires_at: expiresAt ?? null,
      }),
    },
  );
  const data = (await res.json()) as { room: HostRecordRoom };
  return data.room;
}

export async function replaceHostRecordInvite(
  projectPath: string,
  sourceToken: string,
): Promise<HostShareRow> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/shares/record/${encodeURIComponent(sourceToken)}/replace` },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
  const data = (await res.json()) as { share: HostShareRow };
  return data.share;
}

export async function loadHostRecordState(
  projectPath: string,
): Promise<RecordSnapshot | null> {
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
    throw await readApiFailure(res);
  }
  return res.json() as Promise<RecordSnapshot>;
}

export async function loadHostRecordSessions(
  projectPath: string,
): Promise<RecordSessionSummary[]> {
  if (isShareProjectKey(projectPath)) {
    return [];
  }
  const res = await hostFetch(
    `/api/record/sessions?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw await readApiFailure(res);
  }
  const data = (await res.json()) as { sessions: RecordSessionSummary[] };
  return data.sessions;
}

export async function postHostRecordCommand(
  projectPath: string,
  commandType: string,
  payload: Record<string, unknown> = {},
): Promise<RecordSnapshot> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Record transport is host-only");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/record/command" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        command_type: commandType,
        payload,
      }),
    },
  );
  return res.json() as Promise<RecordSnapshot>;
}

export function hostRecordUploadTransport(
  projectPath: string,
): RecordUploadTransport {
  return {
    async status(signal) {
      const res = await apiFetch(
        HOST_KEY,
        { host: `/api/record/upload?path=${encodeURIComponent(projectPath)}` },
        { signal },
      );
      return res.json();
    },
    async put(args) {
      const q = recordUploadSearchParams({
        ...args,
        extra: { path: projectPath },
      });
      const res = await apiFetch(
        HOST_KEY,
        { host: `/api/record/upload?${q.toString()}` },
        {
          method: "POST",
          body: copyUploadBody(args.data),
          signal: args.signal,
        },
      );
      return res.json();
    },
    async revokeRoomTone(signal) {
      const q = new URLSearchParams({
        path: projectPath,
        kind: "room_tone",
      });
      await apiFetch(
        HOST_KEY,
        { host: `/api/record/upload?${q.toString()}` },
        {
          method: "DELETE",
          signal,
        },
      );
    },
  };
}

export async function hostLandRecord(
  projectPath: string,
): Promise<{ clips: unknown[]; align_fallback?: boolean }> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/record/land?path=${encodeURIComponent(projectPath)}` },
    { method: "POST" },
  );
  return res.json();
}

export async function revokeHostRoom(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Share management is not available for shared guests");
  }
  await apiFetch(
    HOST_KEY,
    { host: `/api/shares/rooms/${encodeURIComponent(sessionId)}/revoke` },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
}
