import { hostFetch } from "../api/documentTransport";
import type { DocumentSnapshot } from "../document/projectPatch";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import type { ProjectMeta } from "../types/pipeline";
import type { HistoryDiff } from "../types/project";
import { withAbortTimeout } from "../utils/abortTimeout";
import { readApiError } from "../utils/apiError";

export async function loadReviewBootstrap(token: string): Promise<{
  author?: string;
  capabilities: string[];
  guest_mode?: string;
  meta: { name?: string };
}> {
  const res = await fetch(`${reviewApiBase(token)}/project`);
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<{
    author?: string;
    capabilities: string[];
    guest_mode?: string;
    meta: { name?: string };
  }>;
}

export async function loadDocumentState(
  projectPath: string,
  phase: "shell" | "detail" | "full" = "shell",
  signal?: AbortSignal,
): Promise<DocumentSnapshot> {
  return withAbortTimeout(
    30_000,
    "Document recovery timed out",
    async (timeoutSignal) => {
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const query = `phase=${phase}`;
      const response = isShareProjectKey(projectPath)
        ? await fetch(
            `${reviewApiBase(shareTokenFromKey(projectPath)!)}/daw/document/state?${query}`,
            { signal: requestSignal },
          )
        : await hostFetch(
            `/api/document/state?path=${encodeURIComponent(projectPath)}&${query}`,
            { signal: requestSignal },
          );
      if (!response.ok) throw new Error(await readApiError(response));
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
  );
}

export async function loadProjectMeta(
  projectPath: string,
): Promise<ProjectMeta> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(`${reviewApiBase(token)}/daw/meta`);
    if (!res.ok) {
      throw new Error(await res.text());
    }
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
  const res = await hostFetch(
    `/api/project/meta?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
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
  const res = await hostFetch(
    `/api/history/diff?path=${encodeURIComponent(projectPath)}&from_index=${fromIndex}&to_index=${toIndex}`,
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<HistoryDiff>;
}
export async function createEpisodeProject(
  workspaceDir: string,
  name: string,
): Promise<{ project_path: string; name: string }> {
  const res = await hostFetch("/api/project/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_dir: workspaceDir, name }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<{ project_path: string; name: string }>;
}

export async function openEpisodeProject(
  path: string,
): Promise<{ project_path: string; name: string }> {
  const res = await hostFetch("/api/project/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<{ project_path: string; name: string }>;
}

export async function closeEpisodeProject(signal?: AbortSignal): Promise<void> {
  const res = await hostFetch("/api/project/close", {
    method: "POST",
    signal,
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
}

export type PickEpisodeProjectResult =
  | { project_path: string }
  | { cancelled: true; detail?: string }
  | { unavailable: true; detail?: string };

export async function pickEpisodeProject(): Promise<PickEpisodeProjectResult> {
  const res = await hostFetch("/api/project/pick", {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
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

    let res: Response;
    if (isShareProjectKey(projectPath)) {
      const token = shareTokenFromKey(projectPath)!;
      res = await fetch(`${reviewApiBase(token)}/daw/media/upload?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      });
    } else {
      params.set("path", projectPath);
      res = await hostFetch(`/api/media/upload?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      });
    }
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
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
