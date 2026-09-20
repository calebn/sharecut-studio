import {
  applyDocumentResult,
  mergeGuestActionDone,
  mergeReturnedComment,
} from "./document/applyDocumentUpdate";
import { commentFromCommandResult } from "./document/projectPatch";
import {
  copyUploadBody,
  recordUploadSearchParams,
} from "./record/upload/params";
import { authHeaders, getSessionToken } from "./sessionAuth";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "./shareMode";
import type {
  PipelineAnalyzeResponse,
  PipelineConfigResponse,
  PipelineEvent,
  PipelineJobSnapshot,
  PipelineStatusResponse,
  ProjectMeta,
} from "./types/pipeline";
import type {
  HistoryDiff,
  PeaksData,
  ProjectView,
  TimelineComment,
} from "./types/project";
import type {
  SessionMeta,
  SessionState,
  ViewerSessionSnapshot,
} from "./types/session";
import type {
  HostRecordRoom,
  HostShareRow,
  HostSharesResponse,
  ShareRole,
} from "./types/shares";
import { readApiError } from "./utils/apiError";
import {
  documentClientId,
  newCommandId,
  nextDocumentClientSeq,
} from "./utils/documentClient";
import { jobResultPaths } from "./utils/pipeline";

async function hostFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}
export async function loadReviewBootstrap(token: string): Promise<{
  capabilities: string[];
  guest_mode?: string;
  meta: { name?: string };
}> {
  const res = await fetch(`${reviewApiBase(token)}/project`);
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<{
    capabilities: string[];
    guest_mode?: string;
    meta: { name?: string };
  }>;
}

export async function loadProject(
  projectPath: string,
  init?: { signal?: AbortSignal },
): Promise<ProjectView> {
  return loadProjectPhase(
    projectPath,
    "shell",
    init?.signal,
  ) as Promise<ProjectView>;
}

export async function loadProjectDetail(
  projectPath: string,
  init?: { signal?: AbortSignal },
): Promise<Partial<ProjectView>> {
  return loadProjectPhase(projectPath, "detail", init?.signal);
}

async function loadProjectPhase(
  projectPath: string,
  // HTTP phases match ViewProjection / guest OpenAPI; Applied uses WS snapshot.patch.
  phase:
    | "shell"
    | "detail"
    | "full"
    | "tracks"
    | "comments"
    | "clips"
    | "fx"
    | "envelopes",
  signal?: AbortSignal,
): Promise<ProjectView | Partial<ProjectView>> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/daw/project?phase=${encodeURIComponent(phase)}`,
      { signal },
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return res.json() as Promise<ProjectView>;
  }
  const res = await hostFetch(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=${encodeURIComponent(phase)}`,
    { signal },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<ProjectView>;
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

export async function loadPeaks(
  projectPath: string,
  trackId: string,
): Promise<PeaksData | null> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/daw/peaks/${encodeURIComponent(trackId)}`,
    );
    if (!res.ok) {
      return null;
    }
    return res.json() as Promise<PeaksData>;
  }
  const res = await hostFetch(
    `/api/peaks/${encodeURIComponent(trackId)}?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    return null;
  }
  return res.json() as Promise<PeaksData>;
}

export type WaveformSnapPayload = {
  track_id: string;
  start: number;
  end: number;
  timeline_mode: boolean;
  preview: Record<string, unknown> | null;
  islands: Array<{ start: number; end: number; midpoint: number }>;
  ticks: number[];
};

export async function loadWaveformSnap(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  timeline = false,
  signal?: AbortSignal,
  focus?: number,
): Promise<WaveformSnapPayload | null> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const params = new URLSearchParams({
      track_id: trackId,
      start: String(start),
      end: String(end),
      timeline: timeline ? "true" : "false",
    });
    if (focus != null) {
      params.set("focus", String(focus));
    }
    const res = await fetch(
      `${reviewApiBase(token)}/daw/waveform-snap?${params.toString()}`,
      { signal },
    );
    if (!res.ok) {
      return null;
    }
    return res.json() as Promise<WaveformSnapPayload>;
  }
  const params = new URLSearchParams({
    path: projectPath,
    track_id: trackId,
    start: String(start),
    end: String(end),
    timeline: timeline ? "true" : "false",
  });
  if (focus != null) {
    params.set("focus", String(focus));
  }
  const res = await hostFetch(`/api/waveform-snap?${params.toString()}`, {
    signal,
  });
  if (!res.ok) {
    return null;
  }
  return res.json() as Promise<WaveformSnapPayload>;
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

export async function submitDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: {
    command_id?: string;
    client_seq?: number;
    structural_mode?: "propose" | "apply";
    offline?: boolean;
  },
): Promise<Record<string, unknown>> {
  const command_id = opts?.command_id ?? newCommandId();
  const client_seq = opts?.client_seq ?? nextDocumentClientSeq();
  const bodyBase = {
    client_id: documentClientId(),
    client_seq,
    command_id,
    type,
    payload,
    ...(opts?.structural_mode ? { structural_mode: opts.structural_mode } : {}),
  };

  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const structural =
      type === "SplitAtTime" ||
      type === "DeleteClip" ||
      type === "RippleDeleteClip";
    const offline =
      opts?.offline === true ||
      (typeof navigator !== "undefined" && navigator.onLine === false);
    const structural_mode =
      opts?.structural_mode ?? (offline && structural ? "propose" : undefined);

    const { enqueueCommand, removeQueuedCommand } = await import(
      "./state/offlineStore"
    );
    await enqueueCommand(token, {
      command_id,
      client_seq,
      type,
      payload,
      structural_mode,
      created_at: Date.now(),
    });

    try {
      const res = await fetch(`${reviewApiBase(token)}/daw/document/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...bodyBase,
          role: "guest",
          ...(structural_mode ? { structural_mode } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await readApiError(res);
        if (res.status === 409) {
          const { addConflict } = await import("./state/offlineStore");
          await addConflict(token, {
            command: {
              command_id,
              client_seq,
              type,
              payload,
              created_at: Date.now(),
            },
            reason: detail,
          });
          await removeQueuedCommand(token, command_id);
        }
        throw new Error(detail);
      }
      await removeQueuedCommand(token, command_id);
      const data = (await res.json()) as Record<string, unknown>;
      applyDocumentResult(data);
      return data;
    } catch (err) {
      if (
        offline ||
        (typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        return {
          ok: true,
          queued: true,
          command_id,
          client_seq,
        };
      }
      throw err;
    }
  }
  const res = await hostFetch(
    `/api/document/command?path=${encodeURIComponent(projectPath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...bodyBase,
        role: "viewer",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as Record<string, unknown>;
  applyDocumentResult(data);
  return data;
}

export async function undoHistory(
  projectPath: string,
  opts?: { rerender?: boolean },
): Promise<void> {
  await submitDocumentCommand(projectPath, "UndoHistory", {
    rerender: opts?.rerender ?? false,
  });
}

export async function redoHistory(
  projectPath: string,
  opts?: { rerender?: boolean },
): Promise<void> {
  await submitDocumentCommand(projectPath, "RedoHistory", {
    rerender: opts?.rerender ?? false,
  });
}

export async function approveEdits(
  projectPath: string,
  ids: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "ApproveEdits", { ids });
}

export async function rejectEdits(
  projectPath: string,
  ids: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "RejectEdits", { ids });
}

export async function updatePendingEdit(
  projectPath: string,
  id: string,
  start: number,
  end: number,
  snap = true,
  trackIds?: string[] | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdatePendingEdit", {
    id,
    start,
    end,
    snap,
    ...(trackIds != null ? { track_ids: trackIds } : {}),
  });
}

export async function restoreAppliedEdit(
  projectPath: string,
  id: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RestoreAppliedEdit", { id });
}

export async function setClipFade(
  projectPath: string,
  clipId: string,
  fadeInMs: number,
  fadeOutMs: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetClipFade", {
    clip_id: clipId,
    fade_in_ms: fadeInMs,
    fade_out_ms: fadeOutMs,
  });
}

export async function trimClipEdge(
  projectPath: string,
  clipId: string,
  edge: "in" | "out",
  sourceSec: number,
  mode: "ripple" = "ripple",
): Promise<void> {
  await submitDocumentCommand(projectPath, "TrimClipEdge", {
    clip_id: clipId,
    edge,
    source_sec: sourceSec,
    mode,
  });
}

export async function rollClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  deltaSec: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RollClipJoin", {
    left_clip_id: leftClipId,
    right_clip_id: rightClipId,
    delta_sec: deltaSec,
  });
}

export async function moveClips(
  projectPath: string,
  clips: Array<{
    clip_id: string;
    timeline_start: number;
    track_id: string;
  }>,
): Promise<void> {
  await submitDocumentCommand(projectPath, "MoveClips", { clips });
}

export async function setJoinMode(
  projectPath: string,
  clipId: string,
  joinInMode: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetJoinMode", {
    clip_id: clipId,
    join_in_mode: joinInMode,
  });
}

export async function applyFadeRecommendations(
  projectPath: string,
  trackId?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "ApplyFadeRecommendations", {
    track_id: trackId ?? null,
  });
}

export async function setEffectBypass(
  projectPath: string,
  trackId: string,
  effectIndex: number,
  bypass: boolean,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetEffectBypass", {
    track_id: trackId,
    effect_index: effectIndex,
    bypass,
  });
}

export async function correctTranscriptWord(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  text: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "CorrectTranscriptWord", {
    track_id: trackId,
    word_index: wordIndex,
    text,
  });
}

export async function correctTranscriptPhrase(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  text: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "CorrectTranscriptPhrase", {
    track_id: trackId,
    start_word_index: startWordIndex,
    end_word_index: endWordIndex,
    text,
  });
}

export async function setTranscriptWordSuppressed(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  suppressed: boolean,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetTranscriptWordSuppressed", {
    track_id: trackId,
    word_index: wordIndex,
    suppressed,
  });
}

export async function setEnvelope(
  projectPath: string,
  trackId: string,
  points: { time: number; value: number }[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetEnvelope", {
    track_id: trackId,
    points,
  });
}

export async function addChapter(
  projectPath: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "AddChapter", { time, title });
}

export async function updateChapter(
  projectPath: string,
  oldTime: number,
  oldTitle: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdateChapter", {
    old_time: oldTime,
    old_title: oldTitle,
    time,
    title,
  });
}

export async function deleteChapter(
  projectPath: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteChapter", { time, title });
}

export async function addSocialClip(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  title?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "AddSocialClip", {
    track_id: trackId,
    start,
    end,
    title: title ?? null,
  });
}

export async function updateSocialClip(
  projectPath: string,
  id: string,
  start: number,
  end: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdateSocialClip", {
    id,
    start,
    end,
  });
}

export async function deleteSocialClip(
  projectPath: string,
  id: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteSocialClip", { id });
}

export async function suggestPendingEdit(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  reason?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SuggestPendingEdit", {
    track_id: trackId,
    start,
    end,
    reason: reason ?? null,
  });
}

export async function splitAtTime(
  projectPath: string,
  atTime: number,
  trackIds?: string[] | null,
  reason?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SplitAtTime", {
    at_time: atTime,
    track_ids: trackIds ?? null,
    reason: reason ?? null,
  });
}

export async function deleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteClip", {
    clip_ids: clipIds,
  });
}

export async function rippleDeleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "RippleDeleteClip", {
    clip_ids: clipIds,
  });
}

export async function duplicateSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DuplicateSegment", {
    source_start: sourceStart,
    source_end: sourceEnd,
    insert_at: insertAt,
  });
}

export async function moveSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "MoveSegment", {
    source_start: sourceStart,
    source_end: sourceEnd,
    insert_at: insertAt,
  });
}

export async function pasteSegment(
  projectPath: string,
  insertAt: number,
  duration: number,
  extracts: Array<Record<string, unknown>>,
): Promise<void> {
  await submitDocumentCommand(projectPath, "PasteSegment", {
    insert_at: insertAt,
    duration,
    extracts,
  });
}

export async function rippleDeleteRange(
  projectPath: string,
  start: number,
  end: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RippleDeleteRange", {
    start,
    end,
  });
}

/** Reload project view after a document-plane mutation. */
export async function refreshProject(
  projectPath: string,
): Promise<ProjectView> {
  return loadProject(projectPath);
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

export async function closeEpisodeProject(): Promise<void> {
  const res = await hostFetch("/api/project/close", {
    method: "POST",
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

export async function addTrackCommand(
  projectPath: string,
  opts?: {
    track_id?: string;
    label?: string;
    role?: string;
    speaker?: string;
  },
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "AddTrack", { ...(opts ?? {}) });
}

export async function setTrackMediaCommand(
  projectPath: string,
  trackId: string,
  relPath: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackMedia", {
    track_id: trackId,
    rel_path: relPath,
  });
}

export async function setTrackMetaCommand(
  projectPath: string,
  trackId: string,
  opts: { label?: string; role?: string; speaker?: string },
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackMeta", {
    track_id: trackId,
    ...opts,
  });
}

export async function removeTrackCommand(
  projectPath: string,
  trackId: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "RemoveTrack", {
    track_id: trackId,
  });
}

export async function reorderTrackCommand(
  projectPath: string,
  trackId: string,
  index: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "ReorderTrack", {
    track_id: trackId,
    index,
  });
}

export async function loadPipelineSteps(): Promise<string[]> {
  const res = await hostFetch("/api/pipeline/steps");
  if (!res.ok) {
    throw new Error(await res.text());
  }
  const data = (await res.json()) as { steps: string[] };
  return data.steps;
}

export async function loadPipelineConfig(
  projectPath: string,
): Promise<PipelineConfigResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline config is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/pipeline/config?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<PipelineConfigResponse>;
}

export async function putPipelineConfig(
  projectPath: string,
  body: {
    config?: Record<string, unknown>;
    enabled_steps?: string[];
    unattended?: boolean;
    reset?: boolean;
  },
): Promise<PipelineConfigResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline config is not available for shared guests");
  }
  const res = await hostFetch("/api/pipeline/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<PipelineConfigResponse>;
}

export async function analyzePipeline(
  projectPath: string,
  opts?: { apply?: boolean },
): Promise<PipelineAnalyzeResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline analyze is not available for shared guests");
  }
  const res = await hostFetch("/api/pipeline/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      apply: opts?.apply ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<PipelineAnalyzeResponse>;
}

export async function loadPipelineStatus(init?: {
  signal?: AbortSignal;
}): Promise<PipelineStatusResponse> {
  const res = await hostFetch("/api/pipeline/status", { signal: init?.signal });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<PipelineStatusResponse>;
}

export async function startPipelineRun(
  projectPath: string,
  opts?: {
    fromStep?: string;
    onlyStep?: string;
    skipSteps?: string[];
    enabledSteps?: string[];
    unattended?: boolean;
    config?: Record<string, unknown>;
    useWorkingSet?: boolean;
  },
): Promise<PipelineJobSnapshot> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline is not available for shared guests");
  }
  const res = await hostFetch("/api/pipeline/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      from_step: opts?.fromStep ?? null,
      only_step: opts?.onlyStep ?? null,
      skip_steps: opts?.skipSteps ?? null,
      enabled_steps: opts?.enabledSteps ?? null,
      unattended: opts?.unattended ?? null,
      config: opts?.config ?? null,
      use_working_set: opts?.useWorkingSet ?? true,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

export async function cancelPipelineRun(
  jobId?: string | null,
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/pipeline/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId ?? null }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

/** Host: async job. Guest edit share: sync rebuild on host. */
export async function startRenderPreview(
  projectPath: string,
): Promise<
  { mode: "job"; job: PipelineJobSnapshot } | { mode: "sync"; ok: boolean }
> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(`${reviewApiBase(token)}/daw/render-preview`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    const data = (await res.json()) as {
      ok?: boolean;
      render?: { ok?: boolean };
    };
    const ok = data.ok !== false && data.render?.ok !== false;
    if (!ok) {
      throw new Error("Render preview failed");
    }
    return { mode: "sync", ok: true };
  }
  const res = await hostFetch("/api/pipeline/render-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return { mode: "job", job: data.job };
}

export async function bounceAudio(
  projectPath: string,
  body: {
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startBounceJob(projectPath, body);
  return followExportJob(job.id, "Bounce failed", opts);
}

export async function startBounceJob(
  projectPath: string,
  body: {
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/export/bounce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as {
    job?: PipelineJobSnapshot;
    job_id?: string;
  };
  if (data.job) {
    return data.job;
  }
  if (data.job_id) {
    return {
      id: data.job_id,
      project_path: projectPath,
      from_step: null,
      only_step: null,
      kind: "bounce",
      status: "queued",
      current: null,
      total: null,
      message: "Bounce",
      error: null,
      elapsed_sec: 0,
      steps: [],
    };
  }
  throw new Error("Bounce did not return a job");
}

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
): Promise<import("./record/types").RecordSnapshot | null> {
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
  return res.json() as Promise<import("./record/types").RecordSnapshot>;
}

export async function postHostRecordCommand(
  projectPath: string,
  commandType: string,
  payload: Record<string, unknown> = {},
): Promise<import("./record/types").RecordSnapshot> {
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
  return res.json() as Promise<import("./record/types").RecordSnapshot>;
}

export function hostRecordUploadTransport(
  projectPath: string,
): import("./record/upload/transport").RecordUploadTransport {
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

export async function exportDeliverables(
  projectPath: string,
  formats?: Record<string, unknown>[] | null,
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startExportJob(projectPath, formats);
  return followExportJob(job.id, "Export failed", opts);
}

export async function startExportJob(
  projectPath: string,
  formats?: Record<string, unknown>[] | null,
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/export/deliverables", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, formats: formats ?? null }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as {
    job?: PipelineJobSnapshot;
    job_id?: string;
  };
  if (data.job) {
    return data.job;
  }
  if (data.job_id) {
    return {
      id: data.job_id,
      project_path: projectPath,
      from_step: null,
      only_step: null,
      kind: "export",
      status: "queued",
      current: null,
      total: null,
      message: "Export deliverables",
      error: null,
      elapsed_sec: 0,
      steps: [],
    };
  }
  throw new Error("Export did not return a job");
}

/**
 * Wait until a Studio job reaches ok|error|cancelled.
 *
 * Prefers SSE for the specific job id so completion is not lost when a later
 * job replaces the global ``/api/pipeline/status`` snapshot. Falls back to
 * status polling (manager retains finished jobs briefly).
 */
export async function followExportJob(
  jobId: string,
  failLabel: string,
  opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<string[]> {
  // Poll-only: the viewer already attaches SSE via usePipelineJob; a second
  // EventSource on the same Queue can steal `done`.
  const done = await waitForPipelineJob(jobId, {
    ...opts,
    pollOnly: true,
  });
  if (done.status !== "ok") {
    throw new Error(done.error || done.message || failLabel);
  }
  return jobResultPaths(done);
}

export async function waitForPipelineJob(
  jobId: string,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    pollOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<PipelineJobSnapshot> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const pollMs = opts?.pollMs ?? 250;
  const pollOnly = opts?.pollOnly ?? false;
  const signal = opts?.signal;
  const started = Date.now();

  const fromStatus = async (): Promise<PipelineJobSnapshot | null> => {
    const st = await loadPipelineStatus();
    const rows = [st.job, ...(st.jobs ?? [])].filter(
      (job): job is PipelineJobSnapshot => job != null,
    );
    return (
      rows.find(
        (job) =>
          job.id === jobId &&
          (job.status === "ok" ||
            job.status === "error" ||
            job.status === "cancelled"),
      ) ?? null
    );
  };

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const early = await fromStatus();
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (early) {
    return early;
  }

  return new Promise<PipelineJobSnapshot>((resolve, reject) => {
    let settled = false;
    let pollTimer: number | null = null;
    const es = pollOnly ? null : new EventSource(pipelineEventsUrl(jobId));

    const finish = (job: PipelineJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
      }
      window.clearTimeout(timeout);
      es?.close();
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
      }
      window.clearTimeout(timeout);
      es?.close();
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    };

    const onAbort = () => {
      fail(new DOMException("Aborted", "AbortError"));
    };

    const timeout = window.setTimeout(() => {
      fail(new Error("Timed out waiting for job"));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
    }

    if (es) {
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as PipelineEvent;
          const job = data.job;
          if (
            job?.id === jobId &&
            (job.status === "ok" ||
              job.status === "error" ||
              job.status === "cancelled")
          ) {
            finish(job);
          }
        } catch {
          /* ignore malformed */
        }
      };

      es.onerror = () => {
        // EventSource retries; poll as a safety net while open.
      };
    }

    pollTimer = window.setInterval(() => {
      if (Date.now() - started >= timeoutMs) {
        fail(new Error("Timed out waiting for job"));
        return;
      }
      void fromStatus()
        .then((job) => {
          if (job) {
            finish(job);
          }
        })
        .catch(() => {
          /* ignore transient */
        });
    }, pollMs);
  });
}

export function pipelineEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/pipeline/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/pipeline/events";
}

export type BootstrapComponentStatus = {
  ok: boolean;
  required_for_first_run?: boolean;
  source?: string;
  model?: string;
  cache?: string;
  path?: string;
  note?: string;
};

export type WhisperModelChoice = {
  id: string;
  label: string;
  size: string;
  description: string;
  /** Present on pipeline config / bootstrap status when cache was probed. */
  cached?: boolean;
};

export type BootstrapStatus = {
  ready: boolean;
  /** True when a HTTPS funnel CDN base is configured (env or manifest default). Not the latest.json URL string. */
  cdn_base: boolean;
  whisper_model: string;
  whisper_models?: WhisperModelChoice[];
  components: Record<string, BootstrapComponentStatus>;
  default_components: string[];
  optional_components: string[];
};

export type BootstrapJobSnapshot = {
  id: string;
  kind: string;
  components: string[];
  whisper_model: string;
  status: string;
  current?: number | null;
  total?: number | null;
  message?: string | null;
  error?: string | null;
  elapsed_sec?: number;
  result?: Record<string, unknown> | null;
};

export async function fetchBootstrapStatus(
  whisperModel?: string,
): Promise<BootstrapStatus> {
  const query =
    whisperModel != null && whisperModel !== ""
      ? `?whisper_model=${encodeURIComponent(whisperModel)}`
      : "";
  const res = await hostFetch(`/api/bootstrap/status${query}`);
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return (await res.json()) as BootstrapStatus;
}

export async function runBootstrap(opts?: {
  components?: string[];
  whisper_model?: string;
  force?: boolean;
}): Promise<{ job: BootstrapJobSnapshot }> {
  const res = await hostFetch("/api/bootstrap/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      components: opts?.components ?? null,
      whisper_model: opts?.whisper_model ?? null,
      force: opts?.force ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return (await res.json()) as { job: BootstrapJobSnapshot };
}

export function bootstrapEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/bootstrap/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/bootstrap/events";
}

export type DistributionMetadata = {
  support_url: string;
  privacy_url: string;
  repository_url: string;
  release_manifest_url: string | null;
};

export async function fetchDiagnosticsMeta(): Promise<DistributionMetadata> {
  const res = await hostFetch("/api/diagnostics");
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<DistributionMetadata>;
}

export type DiagnosticsBundleResult = {
  path: string;
  filename: string;
  support_url: string;
  size_bytes: number;
};

export async function createDiagnosticsBundle(opts?: {
  outDir?: string;
  path?: string;
}): Promise<DiagnosticsBundleResult> {
  const res = await hostFetch("/api/diagnostics/bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      out_dir: opts?.outDir ?? null,
      path: opts?.path ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<DiagnosticsBundleResult>;
}

export async function fetchBootstrapJob(
  jobId: string,
): Promise<BootstrapJobSnapshot | null> {
  const res = await hostFetch(
    `/api/bootstrap/status-job?job_id=${encodeURIComponent(jobId)}`,
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const body = (await res.json()) as { job?: BootstrapJobSnapshot | null };
  return body.job ?? null;
}

/** Wait for a bootstrap job via SSE; poll status-job when EventSource errors. */
export function waitForBootstrapJob(
  jobId: string,
  opts?: {
    onUpdate?: (job: BootstrapJobSnapshot) => void;
    pollMs?: number;
  },
): Promise<BootstrapJobSnapshot> {
  const pollMs = opts?.pollMs ?? 1500;
  return new Promise<BootstrapJobSnapshot>((resolve, reject) => {
    let settled = false;
    let pollTimer: number | null = null;
    const es = new EventSource(bootstrapEventsUrl(jobId));

    const cleanup = () => {
      es.close();
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const finishOk = (job: BootstrapJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(job);
    };

    const finishErr = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const consider = (job: BootstrapJobSnapshot | null | undefined) => {
      if (!job) {
        return;
      }
      opts?.onUpdate?.(job);
      if (job.status === "ok") {
        finishOk(job);
      } else if (job.status === "error" || job.status === "cancelled") {
        finishErr(
          new Error(job.error || job.message || `Bootstrap ${job.status}`),
        );
      }
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          type?: string;
          job?: BootstrapJobSnapshot;
        };
        if (data.job) {
          consider(data.job);
        } else if (data.type === "done") {
          void fetchBootstrapJob(jobId)
            .then((job) => {
              if (job) {
                consider(job);
              } else {
                finishOk({
                  id: jobId,
                  kind: "bootstrap",
                  components: [],
                  whisper_model: "",
                  status: "ok",
                });
              }
            })
            .catch((e: unknown) => {
              finishErr(e instanceof Error ? e : new Error(String(e)));
            });
        }
      } catch {
        /* ignore malformed SSE */
      }
    };

    es.onerror = () => {
      void fetchBootstrapJob(jobId)
        .then((job) => {
          if (job) {
            consider(job);
            if (job.status === "queued" || job.status === "running") {
              return;
            }
            return;
          }
          if (!settled) {
            finishErr(
              new Error("Lost connection while waiting for bootstrap job"),
            );
          }
        })
        .catch(() => {
          /* interval poll may recover */
        });
    };

    pollTimer = window.setInterval(() => {
      void fetchBootstrapJob(jobId)
        .then((job) => consider(job))
        .catch(() => {
          /* ignore transient */
        });
    }, pollMs);
  });
}

export async function createComment(
  projectPath: string,
  opts: {
    body: string;
    author: string;
    timelineStart: number;
    timelineEnd?: number | null;
    trackIds?: string[];
    actionTexts?: string[];
    editDecisionId?: string | null;
  },
): Promise<TimelineComment> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(`${reviewApiBase(token)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: opts.body,
        author: opts.author,
        timeline_start: opts.timelineStart,
        timeline_end: opts.timelineEnd ?? null,
        edit_decision_id: opts.editDecisionId ?? null,
        track_ids: opts.trackIds ?? [],
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = (await res.json()) as { comment: TimelineComment };
    mergeReturnedComment(data.comment);
    return data.comment;
  }
  const data = await submitDocumentCommand(projectPath, "AddComment", {
    body: opts.body,
    author: opts.author,
    timeline_start: opts.timelineStart,
    timeline_end: opts.timelineEnd ?? null,
    track_ids: opts.trackIds ?? [],
    action_texts: opts.actionTexts ?? [],
    edit_decision_id: opts.editDecisionId ?? null,
  });
  const comment = commentFromCommandResult(data);
  if (!comment) {
    throw new Error("AddComment did not return a comment");
  }
  return comment;
}

export async function patchComment(
  projectPath: string,
  commentId: string,
  opts: {
    body?: string;
    resolved?: boolean;
    by?: string;
  },
): Promise<TimelineComment> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Resolving comments is not available for shared guests");
  }
  const type = opts.resolved != null ? "ResolveComment" : "UpdateComment";
  const data = await submitDocumentCommand(projectPath, type, {
    comment_id: commentId,
    ...(opts.body != null ? { body: opts.body } : {}),
    ...(opts.resolved != null ? { resolved: opts.resolved } : {}),
    ...(opts.by != null ? { by: opts.by } : {}),
  });
  const comment = commentFromCommandResult(data);
  if (!comment) {
    throw new Error(`${type} did not return a comment`);
  }
  return comment;
}

export async function setCommentActionDone(
  projectPath: string,
  commentId: string,
  actionId: string,
  opts: { done: boolean; by: string },
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/comments/${encodeURIComponent(commentId)}/actions/${encodeURIComponent(actionId)}/done`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          done: opts.done,
          by: opts.by,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    mergeGuestActionDone(commentId, actionId, opts.done);
    return;
  }
  await submitDocumentCommand(projectPath, "SetActionDone", {
    comment_id: commentId,
    action_id: actionId,
    done: opts.done,
    by: opts.by,
  });
}

export async function addCommentReply(
  projectPath: string,
  commentId: string,
  opts: { body: string; author: string },
): Promise<void> {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(
      `${reviewApiBase(token)}/comments/${encodeURIComponent(commentId)}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: opts.body,
          author: opts.author,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    return;
  }
  await submitDocumentCommand(projectPath, "AddReply", {
    comment_id: commentId,
    body: opts.body,
    author: opts.author,
  });
}

export async function loadProxyManifest(
  projectPath: string,
): Promise<import("./audio/proxyMath").ProxyManifest | null> {
  if (!isShareProjectKey(projectPath)) {
    return null;
  }
  const token = shareTokenFromKey(projectPath);
  if (!token) {
    return null;
  }
  const res = await fetch(`${reviewApiBase(token)}/daw/proxy/manifest`);
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as import("./audio/proxyMath").ProxyManifest;
}

export function audioUrl(
  projectPath: string,
  kind: "premix" | "stem" | "raw" | "processed" | "review",
  trackId?: string,
  opts?: {
    rerender?: boolean;
    cacheKey?: string;
    startSec?: number;
    endSec?: number;
  },
): string {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const guestKind = kind === "raw" ? "premix" : kind;
    const params = new URLSearchParams({ kind: guestKind });
    if (trackId && (guestKind === "stem" || guestKind === "processed")) {
      params.set("track_id", trackId);
    }
    if (opts?.cacheKey) {
      params.set("v", opts.cacheKey);
    }
    return `${reviewApiBase(token)}/daw/audio?${params.toString()}`;
  }
  const params = new URLSearchParams({
    path: projectPath,
    kind,
  });
  if (trackId) {
    params.set("track_id", trackId);
  }
  if (opts?.rerender) {
    params.set("rerender", "true");
  }
  if (opts?.cacheKey) {
    params.set("v", opts.cacheKey);
  }
  if (
    opts?.startSec != null &&
    opts?.endSec != null &&
    Number.isFinite(opts.startSec) &&
    Number.isFinite(opts.endSec)
  ) {
    params.set("start_sec", String(opts.startSec));
    params.set("end_sec", String(opts.endSec));
  }
  const st = getSessionToken();
  if (st) {
    params.set("token", st);
  }
  return `/api/audio?${params.toString()}`;
}

export async function loadSessionMeta(
  projectPath: string,
): Promise<SessionMeta> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Session sync is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/session/meta?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionMeta>;
}

export async function loadSessionState(
  projectPath: string,
): Promise<SessionState | null> {
  if (isShareProjectKey(projectPath)) {
    return null;
  }
  const res = await hostFetch(
    `/api/session/state?path=${encodeURIComponent(projectPath)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionState>;
}

export async function postSessionState(
  projectPath: string,
  snapshot: ViewerSessionSnapshot,
): Promise<SessionState> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Session sync is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/session/state?path=${encodeURIComponent(projectPath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionState>;
}
