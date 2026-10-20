import type { DocumentSnapshot } from "../document/projectPatch";
import { isShareProjectKey, shareProjectKey } from "../shareMode";
import type { ProjectMeta } from "../types/pipeline";
import type { HistoryDiff } from "../types/project";
import { withAbortTimeout } from "../utils/abortTimeout";
import { apiFetch, HOST_KEY } from "./http";

export async function loadReviewBootstrap(token: string): Promise<{
  author?: string;
  capabilities: string[];
  guest_mode?: string;
  meta: { name?: string };
}> {
  const res = await apiFetch(shareProjectKey(token), { guest: "/project" });
  return res.json() as Promise<{
    author?: string;
    capabilities: string[];
    guest_mode?: string;
    meta: { name?: string };
  }>;
}

/** What a review link plays: its version, whether it follows the latest, and any newer one a frozen link is missing. */
export type ReviewVersionStatus = {
  versionId: string | null;
  label: string | null;
  followsLatest: boolean;
  newer: { id: string; label: string | null } | null;
};

export async function loadReviewVersionStatus(
  token: string,
  signal?: AbortSignal,
): Promise<ReviewVersionStatus> {
  const res = await apiFetch(
    shareProjectKey(token),
    { guest: "/project" },
    { signal },
  );
  const body = (await res.json()) as {
    review_version?: { id?: string; label?: string | null } | null;
    link_follows_latest?: boolean;
    newer_version?: { id?: string; label?: string | null } | null;
  };
  const newer = body.newer_version;
  return {
    versionId: body.review_version?.id ?? null,
    label: body.review_version?.label ?? null,
    followsLatest: body.link_follows_latest === true,
    newer: newer?.id ? { id: newer.id, label: newer.label ?? null } : null,
  };
}

export async function loadDocumentState(
  projectPath: string,
  phase: "shell" | "detail" | "full" = "shell",
  signal?: AbortSignal,
): Promise<DocumentSnapshot> {
  return withAbortTimeout(
    30_000,
    "The server didn't answer.",
    async (requestSignal) => {
      const query = `phase=${phase}`;
      const response = await apiFetch(
        projectPath,
        {
          host: `/api/document/state?path=${encodeURIComponent(projectPath)}&${query}`,
          guest: `/daw/document/state?${query}`,
        },
        { signal: requestSignal },
      );
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("server_seq" in value) ||
        !Number.isSafeInteger(value.server_seq) ||
        Number(value.server_seq) < 0
      )
        throw new Error("Invalid document state");
      if (
        !("resync" in value && value.resync === true) &&
        (!("state_token" in value) ||
          typeof value.state_token !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.state_token))
      )
        throw new Error("Invalid document basis");
      return value as DocumentSnapshot;
    },
    signal,
  );
}

export async function loadProjectMeta(
  projectPath: string,
): Promise<ProjectMeta> {
  if (isShareProjectKey(projectPath)) {
    const res = await apiFetch(projectPath, { guest: "/daw/meta" });
    const data = (await res.json()) as {
      mtime_ns: number;
      size: number;
      server_seq?: number;
    };
    return {
      path: projectPath,
      mtime_ns: data.mtime_ns,
      size: data.size,
      server_seq: data.server_seq,
    };
  }
  const res = await apiFetch(projectPath, {
    host: `/api/project/meta?path=${encodeURIComponent(projectPath)}`,
  });
  return res.json() as Promise<ProjectMeta>;
}

export async function loadHistoryDiff(
  projectPath: string,
  fromIndex: number,
  toIndex: number,
): Promise<HistoryDiff> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("History diff is not available for shared guests");
  }
  const res = await apiFetch(projectPath, {
    host: `/api/history/diff?path=${encodeURIComponent(projectPath)}&from_index=${fromIndex}&to_index=${toIndex}`,
  });
  return res.json() as Promise<HistoryDiff>;
}
export async function createEpisodeProject(
  workspaceDir: string,
  name: string,
): Promise<{ project_path: string; name: string }> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/project/create" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_dir: workspaceDir, name }),
    },
  );
  return res.json() as Promise<{ project_path: string; name: string }>;
}

export async function openEpisodeProject(
  path: string,
): Promise<{ project_path: string; name: string }> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/project/open" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  return res.json() as Promise<{ project_path: string; name: string }>;
}

export async function closeEpisodeProject(signal?: AbortSignal): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: "/api/project/close" },
    {
      method: "POST",
      signal,
    },
  );
}

export type PickEpisodeProjectResult =
  | { project_path: string }
  | { cancelled: true; detail?: string }
  | { unavailable: true; detail?: string };

export async function pickEpisodeProject(): Promise<PickEpisodeProjectResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/project/pick" },
    {
      method: "POST",
    },
  );
  const body = (await res.json()) as Record<string, unknown>;
  if (body.unavailable === true) {
    return {
      unavailable: true,
      detail: typeof body.detail === "string" ? body.detail : undefined,
    };
  }
  if (body.cancelled === true) {
    return {
      cancelled: true,
      detail: typeof body.detail === "string" ? body.detail : undefined,
    };
  }
  if (typeof body.project_path === "string" && body.project_path.trim()) {
    return { project_path: body.project_path };
  }
  throw new Error("Unexpected pick response");
}

export type MediaUploadResult = {
  complete: boolean;
  rel_path?: string;
  filename?: string;
  upload_id?: string;
  bytes?: number;
  duration_sec?: number;
  chunks_received?: number;
  total_chunks?: number;
};

const MEDIA_CHUNK_BYTES = 3 * 1024 * 1024;

export async function uploadMediaFile(
  projectPath: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<MediaUploadResult> {
  const totalChunks = Math.max(1, Math.ceil(file.size / MEDIA_CHUNK_BYTES));
  let uploadId: string | undefined;
  let last: MediaUploadResult = { complete: false };

  for (let i = 0; i < totalChunks; i++) {
    const start = i * MEDIA_CHUNK_BYTES;
    const end = Math.min(file.size, start + MEDIA_CHUNK_BYTES);
    const chunk = file.slice(start, end);
    const params = new URLSearchParams({
      filename: file.name,
      chunk_index: String(i),
      total_chunks: String(totalChunks),
    });
    if (uploadId) {
      params.set("upload_id", uploadId);
    }

    const hostParams = new URLSearchParams(params);
    hostParams.set("path", projectPath);
    const res = await apiFetch(
      projectPath,
      {
        host: `/api/media/upload?${hostParams}`,
        guest: `/daw/media/upload?${params}`,
      },
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      },
    );
    last = (await res.json()) as MediaUploadResult;
    if (last.upload_id) {
      uploadId = String(last.upload_id);
    }
    onProgress?.((i + 1) / totalChunks);
  }
  if (!last.complete || !last.rel_path) {
    throw new Error("upload did not complete");
  }
  return last;
}
