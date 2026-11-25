import { withSessionTokenQuery } from "../sessionAuth";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { SegmentSaveRequest as GeneratedSaveRequest } from "../types/project.generated";
import { ApiError } from "../utils/apiError";
import { submitDocumentCommand } from "./documentEdits";
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
  "segment_hash_mismatch",
  "segment_media_invalid",
  "segment_write_failed",
  "segment_position_out_of_range",
] as const;

export type SegmentInsertRefusal = (typeof SEGMENT_INSERT_REFUSALS)[number];

export type SegmentInsertAt = "start" | "end" | number;

export interface SegmentInsertRequest {
  segment_id: string;
  at: SegmentInsertAt;
  version?: number;
}

/** What `InsertSegment` did, as the journal stores it. */
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
}

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

/** What an insert would do (the dry run); nothing was written. */
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
}

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

/** The refusal code of a failed insert or preview, or null for any other failure. */
export function segmentInsertRefusal(
  error: unknown,
): SegmentInsertRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return SEGMENT_INSERT_REFUSALS.find((code) => code === error.code) ?? null;
}

/**
 * Insert a library segment into the episode at `path` as one undoable edit.
 * Rejects with an `ApiError` whose code `segmentInsertRefusal` names.
 */
export async function insertSegment(
  path: string,
  request: SegmentInsertRequest,
): Promise<SegmentInsertApplied> {
  const result = await submitDocumentCommand(
    path,
    DocumentCommand.InsertSegment,
    { ...request },
  );
  return result as unknown as SegmentInsertApplied;
}

/** What inserting the segment at `at` would move; writes nothing. */
export async function previewSegmentInsert(
  path: string,
  request: SegmentInsertRequest,
  signal?: AbortSignal,
): Promise<SegmentInsertPreview> {
  const params = new URLSearchParams({ path, at: String(request.at) });
  if (request.version !== undefined)
    params.set("version", String(request.version));
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
