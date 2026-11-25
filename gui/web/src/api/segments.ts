import { withSessionTokenQuery } from "../sessionAuth";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { HistoryEntryId } from "../types/project";
import type {
  SegmentSaveRequest as GeneratedSaveRequest,
  TrackRole,
} from "../types/project.generated";
import { ApiError } from "../utils/apiError";
import { replyHistoryHead, submitDocumentCommand } from "./documentEdits";
import { apiFetch, HOST_KEY } from "./http";

export type SegmentKind = "intro" | "outro" | "sponsor" | "sting" | "other";

export interface SegmentClipRow {
  audio: string;
  offset_sec: number;
  duration_sec: number;
  [key: string]: unknown;
}

/** One library segment: its newest version and every version number. */
export interface SegmentRow {
  id: string;
  name: string;
  kind: SegmentKind;
  version: number;
  versions: number[];
  clips: SegmentClipRow[];
  role?: TrackRole | null;
  duck_under_dialogue?: boolean;
  [key: string]: unknown;
}

/** A segment whose newest version could not be read; listed rather than hidden. */
export interface DamagedSegmentRow {
  id: string;
  version: number;
  damaged: true;
  problem: string;
  code: string;
}

export type SegmentListRow = SegmentRow | DamagedSegmentRow;

export type SegmentSaveRequest = Omit<GeneratedSaveRequest, "kind"> & {
  kind?: SegmentKind | null;
};

export interface SegmentSaveResult {
  status: "added" | "new_version" | "unchanged";
  id: string;
  version: number;
}

export type SegmentDriftState =
  | "current"
  | "newer"
  | "changed"
  | "missing"
  | "damaged";

export interface SegmentDriftRow {
  ref: { segment_id: string; version: number; content_sha256: string };
  state: SegmentDriftState;
  library_version: number | null;
  clips: string[];
  code?: string;
  problem?: string;
}

export const SEGMENT_INSERT_REFUSALS = [
  "segment_unknown",
  "segment_version_invalid",
  "segment_unreadable",
  "segment_busy",
  "segment_hash_mismatch",
  "segment_media_invalid",
  "segment_write_failed",
  "segment_position_out_of_range",
  "segment_placement_unsupported",
  "segment_placement_invalid",
] as const;

export type SegmentInsertRefusal = (typeof SEGMENT_INSERT_REFUSALS)[number];

export const SEGMENT_SAVE_REFUSALS = [
  "segment_clip_too_short",
  "segment_render_unsupported",
  "segment_busy",
  "segment_write_failed",
  "segment_invalid",
  "segment_name_invalid",
] as const;

export type SegmentSaveRefusal = (typeof SEGMENT_SAVE_REFUSALS)[number];

export type SegmentInsertAt = "start" | "end" | number;

export type SegmentPlacement = "ripple" | "own_lane";

export interface SegmentInsertRequest {
  segment_id: string;
  at: SegmentInsertAt;
  version?: number;
  placement?: SegmentPlacement;
}

export interface SegmentInsertApplied {
  operation: "insert_segment";
  affected_tracks: string[];
  clip_count: number;
  timeline_duration_sec: number | null;
  segment_id: string;
  segment_version: number;
  at: number;
  duration_sec: number;
  tracks: Record<string, string>;
  placement?: SegmentPlacement;
}

export const SEGMENT_INSERT_APPLIED_KEYS = [
  "operation",
  "affected_tracks",
  "clip_count",
  "timeline_duration_sec",
  "segment_id",
  "segment_version",
  "at",
  "duration_sec",
  "tracks",
  "placement",
] as const satisfies readonly (keyof SegmentInsertApplied)[];

export type SegmentInsertOutcome =
  | {
      queued: false;
      applied: SegmentInsertApplied;
      historyHead: HistoryEntryId | null;
    }
  | { queued: true; historyHead: null };

export interface SegmentChapterMove {
  title: string;
  from: number;
  to: number;
}

export interface SegmentCommentMove {
  id: string;
  from: number;
  to: number;
}

export interface SegmentInsertPreview {
  dry_run: true;
  segment_id: string;
  segment_version: number;
  at: number;
  duration_sec: number;
  timeline_duration_before_sec: number;
  timeline_duration_after_sec: number;
  clips_moved: number;
  clips_added: number;
  clips_from_segment: number;
  chapters_moved: SegmentChapterMove[];
  chapter_added: string | null;
  comments_moved: SegmentCommentMove[];
  pending_edits_moved: number;
  tracks_added: string[];
  tracks: Record<string, string>;
  placement?: SegmentPlacement;
}

export const SEGMENT_INSERT_PREVIEW_KEYS = [
  "dry_run",
  "segment_id",
  "segment_version",
  "at",
  "duration_sec",
  "timeline_duration_before_sec",
  "timeline_duration_after_sec",
  "clips_moved",
  "clips_added",
  "clips_from_segment",
  "chapters_moved",
  "chapter_added",
  "comments_moved",
  "pending_edits_moved",
  "tracks_added",
  "tracks",
  "placement",
] as const satisfies readonly (keyof SegmentInsertPreview)[];

const JSON_HEADERS = { "Content-Type": "application/json" };

export function isDamagedSegment(
  row: SegmentListRow,
): row is DamagedSegmentRow {
  return "damaged" in row && row.damaged === true;
}

export async function loadSegments(
  signal?: AbortSignal,
): Promise<SegmentListRow[]> {
  const res = await apiFetch(HOST_KEY, { host: "/api/segments" }, { signal });
  return (await res.json()) as SegmentListRow[];
}

export async function loadSegment(
  id: string,
  signal?: AbortSignal,
): Promise<SegmentRow> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(id)}` },
    { signal },
  );
  return (await res.json()) as SegmentRow;
}

/** Which segments inserted into the episode at `path` have drifted from the library. */
export async function loadSegmentDrift(
  path: string,
  signal?: AbortSignal,
): Promise<SegmentDriftRow[]> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/segments/drift?path=${encodeURIComponent(path)}` },
    { signal },
  );
  return (await res.json()) as SegmentDriftRow[];
}

export function segmentInsertRefusal(
  error: unknown,
): SegmentInsertRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return SEGMENT_INSERT_REFUSALS.find((code) => code === error.code) ?? null;
}

export function segmentSaveRefusal(error: unknown): SegmentSaveRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return SEGMENT_SAVE_REFUSALS.find((code) => code === error.code) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function appliedInsert(value: unknown): SegmentInsertApplied {
  if (!isRecord(value) || value.operation !== "insert_segment")
    throw new Error("The insert reply is missing its result.");
  const { segment_id, segment_version, at, duration_sec, clip_count } = value;
  if (
    typeof segment_id !== "string" ||
    typeof segment_version !== "number" ||
    typeof at !== "number" ||
    typeof duration_sec !== "number" ||
    typeof clip_count !== "number"
  )
    throw new Error("The insert reply is malformed.");
  const total = value.timeline_duration_sec;
  const lanes = isRecord(value.tracks) ? value.tracks : {};
  return {
    operation: "insert_segment",
    affected_tracks: strings(value.affected_tracks),
    clip_count,
    timeline_duration_sec: typeof total === "number" ? total : null,
    segment_id,
    segment_version,
    at,
    duration_sec,
    tracks: Object.fromEntries(
      Object.entries(lanes).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    ...(value.placement === "own_lane"
      ? { placement: "own_lane" as const }
      : {}),
  };
}

export async function insertSegment(
  path: string,
  request: SegmentInsertRequest,
  opts?: Parameters<typeof submitDocumentCommand>[3],
): Promise<SegmentInsertOutcome> {
  const reply = await submitDocumentCommand(
    path,
    DocumentCommand.InsertSegment,
    { ...request },
    opts,
  );
  if (reply.queued === true) return { queued: true, historyHead: null };
  const payload = isRecord(reply.command) ? reply.command.payload : null;
  return {
    queued: false,
    applied: appliedInsert(isRecord(payload) ? payload.result : null),
    historyHead: replyHistoryHead(reply),
  };
}

export async function previewSegmentInsert(
  path: string,
  request: SegmentInsertRequest,
  signal?: AbortSignal,
): Promise<SegmentInsertPreview> {
  const params = new URLSearchParams({ path, at: String(request.at) });
  if (request.version !== undefined)
    params.set("version", String(request.version));
  if (request.placement !== undefined)
    params.set("placement", request.placement);
  const res = await apiFetch(
    HOST_KEY,
    {
      host: `/api/segments/${encodeURIComponent(request.segment_id)}/insert-preview?${params.toString()}`,
    },
    { signal },
  );
  return (await res.json()) as SegmentInsertPreview;
}

export async function saveSegment(
  request: SegmentSaveRequest,
  signal?: AbortSignal,
): Promise<SegmentSaveResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/segments" },
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      signal,
    },
  );
  return (await res.json()) as SegmentSaveResult;
}

export async function removeSegment(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: `/api/segments/${encodeURIComponent(id)}` },
    { method: "DELETE", signal },
  );
}

/** The audio of one clip (the whole file; Studio previews one clip at a time). */
export function segmentAudioUrl(
  id: string,
  clip = 0,
  version?: number,
): string {
  const params = new URLSearchParams({ clip: String(clip) });
  if (version !== undefined) params.set("version", String(version));
  return withSessionTokenQuery(
    `/api/segments/${encodeURIComponent(id)}/audio?${params.toString()}`,
  );
}
